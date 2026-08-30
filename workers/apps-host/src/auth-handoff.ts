import type { AppsHostConfig } from "./config";
import { authHandoffSecurityHeaders } from "./http-security";

export const BROWSER_AUTH_HANDOFF_SCRIPT_PATH =
  "/_stella/browser-auth-handoff.js" as const;

export const RETIRED_BROWSER_AUTH_STORAGE_KEYS = [
  "better-auth_session_token",
  "better-auth_cookie",
  "better-auth_session_data",
  "stella_auth_identity_intent",
  "stella_auth_cached_session",
] as const;

export const browserAuthHandoffHtml = (): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Opening Stella</title>
  <style>
    :root{color-scheme:light}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f1e8;color:#182019;font:16px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(100%,480px);padding:40px;background:#fff;border:1px solid #dedbd1;border-radius:22px;box-shadow:0 18px 60px rgba(24,32,25,.09)}
    h1{margin:0 0 12px;font:42px/1.05 Georgia,serif;letter-spacing:-.025em}
    p{margin:0;color:#536057}
    nav{display:none;gap:12px;align-items:center;margin-top:24px}
    button,a{border:0;border-radius:999px;padding:11px 17px;font:600 14px/1 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-decoration:none;cursor:pointer}
    button{background:#182019;color:#fff}
    a{color:#304337;background:#eef0eb}
    main[data-state="error"] nav{display:flex}
  </style>
</head>
<body>
  <main id="handoff" aria-live="polite">
    <h1 id="title">Opening Stella</h1>
    <p id="message">Finishing your secure sign-in…</p>
    <nav>
      <button id="retry" type="button">Retry</button>
      <a href="https://stella.sh/chat" rel="noreferrer">Back to Stella</a>
    </nav>
  </main>
  <script src="${BROWSER_AUTH_HANDOFF_SCRIPT_PATH}"></script>
</body>
</html>`;

export const browserAuthHandoffScript = (config: AppsHostConfig): string => {
  const verifyUrl = "/_stella/auth/exchange";
  const appsHostOrigin = config.appsHostOrigin;
  return `(() => {
  "use strict";

  const VERIFY_URL = ${JSON.stringify(verifyUrl)};
  const APPS_HOST_ORIGIN = ${JSON.stringify(appsHostOrigin)};
  const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/;
  const RETIRED_AUTH_KEYS = ${JSON.stringify(RETIRED_BROWSER_AUTH_STORAGE_KEYS)};
  const root = document.getElementById("handoff");
  const title = document.getElementById("title");
  const message = document.getElementById("message");
  const retry = document.getElementById("retry");
  let token = null;
  let verifying = false;

  for (const key of RETIRED_AUTH_KEYS) {
    try { localStorage.removeItem(key); } catch {}
    try {
      if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(key);
    } catch {}
  }

  const showError = (text, canRetry) => {
    root.dataset.state = "error";
    title.textContent = "Sign-in didn’t finish";
    message.textContent = text;
    retry.hidden = !canRetry;
  };

  const verify = async () => {
    if (!token || verifying) return;
    verifying = true;
    root.dataset.state = "loading";
    title.textContent = "Opening Stella";
    message.textContent = "Finishing your secure sign-in\u2026";
    try {
      const response = await fetch(VERIFY_URL, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error("verification rejected");
      // The trusted Worker consumes Better Auth's bearer header and converts
      // it to an HttpOnly origin cookie. The reusable account credential is
      // therefore never exposed to this document or any custom interior JS.
      const destination = APPS_HOST_ORIGIN + location.pathname.replace(/\\/auth\\/?$/, "/");
      location.replace(destination);
    } catch {
      showError(
        "We couldn\u2019t complete the secure handoff. Retry, or return to stella.sh/chat for a new link.",
        true,
      );
    } finally {
      verifying = false;
    }
  };

  retry.addEventListener("click", () => void verify());

  const rawFragment = location.hash.replace(/^#\\??/, "");
  if (location.hash) {
    history.replaceState(
      history.state,
      "",
      location.pathname + location.search,
    );
  }
  const params = new URLSearchParams(rawFragment);
  const tokens = params.getAll("ott");
  if (tokens.length !== 1 || !TOKEN_PATTERN.test(tokens[0] || "")) {
    showError(
      "This sign-in link is missing or invalid. Return to stella.sh/chat and try again.",
      false,
    );
    return;
  }
  token = tokens[0];
  void verify();
})();`;
};

export const browserAuthHandoffResponse = (
  request: Request,
  config: AppsHostConfig,
): Response =>
  new Response(request.method === "HEAD" ? null : browserAuthHandoffHtml(), {
    headers: {
      ...authHandoffSecurityHeaders(config),
      "content-type": "text/html; charset=utf-8",
    },
  });

export const browserAuthHandoffScriptResponse = (
  request: Request,
  config: AppsHostConfig,
): Response => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", {
      status: 405,
      headers: {
        allow: "GET, HEAD",
        "cache-control": "no-store",
      },
    });
  }
  return new Response(
    request.method === "HEAD" ? null : browserAuthHandoffScript(config),
    {
      headers: {
        ...authHandoffSecurityHeaders(config),
        "content-type": "text/javascript; charset=utf-8",
      },
    },
  );
};
