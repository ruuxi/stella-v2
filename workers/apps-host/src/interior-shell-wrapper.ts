import type { AppsHostConfig } from "./config";

export const INTERIOR_WRAPPER_SCRIPT_PATH =
  "/_stella/interior-wrapper.js" as const;

const RETIRED_AUTH_STORAGE_KEYS = [
  "better-auth_session_token",
  "better-auth_cookie",
  "better-auth_session_data",
  "stella_auth_identity_intent",
  "stella_auth_cached_session",
] as const;

export const interiorWrapperScript = (): string => `(() => {
  "use strict";
  const VERSION = 1;
  const CHILD_READY_SOURCE = "stella-interior-child-ready-v1";
  const PARENT_INIT_SOURCE = "stella-interior-parent-init-v1";
  const CHILD_SOURCE = "stella-interior-child-v1";
  const PARENT_SOURCE = "stella-interior-parent-v1";
  const root = document.documentElement;
  const frame = document.getElementById("stella-interior");
  const bootstrap = root.dataset.bootstrap;
  const gatewayOrigin = root.dataset.gatewayOrigin;
  const stableRouteId = root.dataset.stableRouteId;
  const nonce = crypto.randomUUID();
  const retired = ${JSON.stringify(RETIRED_AUTH_STORAGE_KEYS)};

  for (const key of retired) {
    try { localStorage.removeItem(key); } catch {}
    try { sessionStorage.removeItem(key); } catch {}
  }

  let sessionPromise = null;
  const refreshSession = async () => {
    const response = await fetch(gatewayOrigin + "/api/interior/session", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bootstrap }),
    });
    let value = null;
    try { value = await response.json(); } catch {}
    if (!response.ok || !value || typeof value.token !== "string" ||
        typeof value.expiresAt !== "number" || !value.user) {
      throw new Error(value?.error || "Could not start the Stella interior.");
    }
    return value;
  };
  const session = async (force) => {
    if (force) sessionPromise = null;
    if (!sessionPromise) sessionPromise = refreshSession().catch((error) => {
      sessionPromise = null;
      throw error;
    });
    const current = await sessionPromise;
    if (current.expiresAt <= Date.now() + 30_000) {
      sessionPromise = refreshSession().catch((error) => {
        sessionPromise = null;
        throw error;
      });
      return await sessionPromise;
    }
    return current;
  };
  const respond = (id, ok, result, error) => frame.contentWindow?.postMessage({
    source: PARENT_SOURCE,
    v: VERSION,
    nonce,
    id,
    ok,
    ...(ok ? { result } : { error }),
  }, "*");

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== frame.contentWindow || event.origin !== "null" || !message) return;
    if (message.source === CHILD_READY_SOURCE && message.v === VERSION &&
        Object.keys(message).length === 2) {
      frame.contentWindow?.postMessage({
        source: PARENT_INIT_SOURCE,
        v: VERSION,
        nonce,
        gatewayOrigin,
        stableRouteId,
      }, "*");
      return;
    }
    if (message.source !== CHILD_SOURCE || message.v !== VERSION ||
        message.nonce !== nonce || typeof message.id !== "string" ||
        !/^[A-Za-z0-9._~-]{1,128}$/.test(message.id) ||
        typeof message.method !== "string") return;
    void (async () => {
      try {
        if (message.method === "config") {
          return respond(message.id, true, {
            gatewayOrigin,
            convexCloudUrl: gatewayOrigin,
            convexSiteUrl: gatewayOrigin,
            cloudBuilderWebSocketUrl: gatewayOrigin.replace(/^http/, "ws"),
          });
        }
        if (message.method === "session") {
          const current = await session(false);
          return respond(message.id, true, {
            user: current.user,
            expiresAt: current.expiresAt,
          });
        }
        if (message.method === "token") {
          const current = await session(false);
          return respond(message.id, true, {
            token: current.token,
            expiresAt: current.expiresAt,
          });
        }
        if (message.method === "refresh") {
          const current = await session(true);
          return respond(message.id, true, {
            token: current.token,
            expiresAt: current.expiresAt,
            user: current.user,
          });
        }
        return respond(message.id, false, undefined, "Capability unavailable.");
      } catch (error) {
        respond(message.id, false, undefined,
          error instanceof Error ? error.message : "Interior session unavailable.");
      }
    })();
  });

  // Setting src last ensures retired origin-wide credentials are erased before
  // any custom code runs. Authority arrives through an exact-source init
  // handshake because browsers clear window.name on opaque sandbox navigation.
  frame.src = frame.dataset.rawSrc;
})();`;

export const interiorWrapperResponse = (args: {
  request: Request;
  config: AppsHostConfig;
  stableRouteId: string;
  bootstrap: string;
  rawUrl: string;
}): Response => {
  const html = `<!doctype html><html data-bootstrap="${args.bootstrap}" data-gateway-origin="${args.config.trustedAppsHostOrigin}" data-stable-route-id="${args.stableRouteId}"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Stella</title><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;display:block}body{overflow:hidden;background:#181a1e}</style><iframe id="stella-interior" title="Stella" data-raw-src="${args.rawUrl}" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"></iframe><script src="${INTERIOR_WRAPPER_SCRIPT_PATH}"></script></html>`;
  return new Response(args.request.method === "HEAD" ? null : html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
        `frame-src 'self'; connect-src ${args.config.trustedAppsHostOrigin}; ` +
        "object-src 'none'; base-uri 'none'; " +
        "frame-ancestors file: http://localhost:* http://127.0.0.1:* https://stella.sh",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
};
