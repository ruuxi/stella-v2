/**
 * Public read access to the published app (the `upstream` Artifacts repo) for
 * callers without an account: signed-out desktops checking for updates and the
 * launcher's first install. Upstream is the published app anyway, so one read
 * token is shared: cached in the isolate and at the edge for about 50 minutes
 * instead of minted per caller.
 */

import type { AppSourceRemote } from "@stella/contracts/backend/app-source";
import { errorMessage, log } from "./build-session/shared/keys.js";

export const APP_SOURCE_BOOTSTRAP_PATH = "/api/app-source/bootstrap";

const UPSTREAM_REPO = "upstream";
const TOKEN_TTL_SECONDS = 60 * 60;
const CACHE_TTL_MS = 50 * 60_000;
/** A cached token is served only while it has at least this long left. */
const MIN_REMAINING_MS = 10 * 60_000;
const CACHE_NAME = "stella-app-source-bootstrap-v1";
/** Per deployment: dev and prod workers share the workers.dev zone's cache. */
const cacheKey = (host: string) => `https://app-source-bootstrap.internal/${host}/upstream`;

let memo: AppSourceRemote | null = null;
let minting: Promise<AppSourceRemote> | null = null;

const fresh = (value: AppSourceRemote | null, now = Date.now()) =>
  value !== null && value.expiresAt - MIN_REMAINING_MS > now;

const edgeCache = async (): Promise<Cache | null> => {
  try {
    return typeof caches === "undefined" ? null : await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
};

const readEdge = async (cache: Cache | null, key: string): Promise<AppSourceRemote | null> => {
  const hit = await cache?.match(key).catch(() => undefined);
  if (!hit) return null;
  const value = (await hit.json().catch(() => null)) as AppSourceRemote | null;
  return value &&
    typeof value.remote === "string" &&
    typeof value.token === "string" &&
    typeof value.expiresAt === "number"
    ? value
    : null;
};

const mint = async (artifacts: Artifacts): Promise<AppSourceRemote> => {
  const repo = await artifacts.get(UPSTREAM_REPO);
  try {
    const [info, token] = await Promise.all([
      repo.info(),
      repo.createToken("read", TOKEN_TTL_SECONDS),
    ]);
    return {
      remote: info.remote,
      token: token.plaintext,
      expiresAt: Date.parse(token.expiresAt),
    };
  } finally {
    (repo as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
  }
};

const upstreamAccess = async (artifacts: Artifacts, host: string): Promise<AppSourceRemote> => {
  if (fresh(memo)) return memo!;
  minting ??= (async () => {
    const cache = await edgeCache();
    const cached = await readEdge(cache, cacheKey(host));
    if (fresh(cached)) return cached!;
    const minted = await mint(artifacts);
    const maxAge = Math.max(
      0,
      Math.floor(Math.min(CACHE_TTL_MS, minted.expiresAt - MIN_REMAINING_MS - Date.now()) / 1000),
    );
    await cache
      ?.put(
        cacheKey(host),
        new Response(JSON.stringify(minted), {
          headers: { "content-type": "application/json", "cache-control": `max-age=${maxAge}` },
        }),
      )
      .catch(() => {});
    return minted;
  })().finally(() => {
    minting = null;
  });
  memo = await minting;
  return memo;
};

/** `POST /api/app-source/bootstrap` → `{ upstream: AppSourceRemote }`; null for other paths. */
export const handleAppSourceBootstrap = async (
  request: Request,
  env: { ARTIFACTS: Artifacts },
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== APP_SOURCE_BOOTSTRAP_PATH) return null;
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { allow: "POST" } });
  }
  try {
    const upstream = await upstreamAccess(env.ARTIFACTS, url.host);
    return Response.json({ upstream }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    log("error", "app_source_bootstrap_failed", { message: errorMessage(error) });
    return Response.json(
      { error: "Stella's source is not available right now.", retryable: true },
      { status: 503, headers: { "retry-after": "30" } },
    );
  }
};
