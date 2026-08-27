import type { AppsHostConfig } from "./config";
import { authHandoffSecurityHeaders } from "./http-security";

export const BROWSER_AUTH_HANDOFF_SCRIPT_PATH =
  "/_stella/browser-auth-handoff.js" as const;

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
  const verifyUrl = new URL(
    "/api/auth/cross-domain/one-time-token/verify",
    config.convexSiteOrigin,
  ).toString();
  return `(() => {
  "use strict";

  const VERIFY_URL = ${JSON.stringify(verifyUrl)};
  const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{8,2048}$/;
  const COOKIE_KEY = "better-auth_cookie";
  const SESSION_DATA_KEY = "better-auth_session_data";
  const COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\\-.^_|~]{1,256}$/;
  const COOKIE_VALUE_PATTERN = /^[\\x21\\x23-\\x2B\\x2D-\\x3A\\x3C-\\x5B\\x5D-\\x7E]{1,4096}$/;
  const MAX_COOKIE_STORAGE_BYTES = 65536;
  const MAX_COOKIE_HEADER_BYTES = 16384;
  const MAX_COOKIE_COUNT = 64;
  const root = document.getElementById("handoff");
  const title = document.getElementById("title");
  const message = document.getElementById("message");
  const retry = document.getElementById("retry");
  let token = null;
  let verifying = false;

  const showError = (text, canRetry) => {
    root.dataset.state = "error";
    title.textContent = "Sign-in didn’t finish";
    message.textContent = text;
    retry.hidden = !canRetry;
  };

  const isStoredCookie = (name, record) =>
    COOKIE_NAME_PATTERN.test(name) &&
    record &&
    typeof record === "object" &&
    typeof record.value === "string" &&
    COOKIE_VALUE_PATTERN.test(record.value) &&
    (record.expires === null ||
      record.expires === undefined ||
      typeof record.expires === "string");

  const readStoredCookies = () => {
    const raw = localStorage.getItem(COOKIE_KEY);
    const clean = Object.create(null);
    if (!raw || raw.length > MAX_COOKIE_STORAGE_BYTES) return clean;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return clean;
      }
      for (const [name, record] of Object.entries(parsed).slice(0, MAX_COOKIE_COUNT)) {
        if (isStoredCookie(name, record)) clean[name] = record;
      }
      return clean;
    } catch {
      return clean;
    }
  };

  const cookieHeader = (cookies) => {
    const now = Date.now();
    const header = Object.entries(cookies)
      .filter(([name, record]) => {
        if (!isStoredCookie(name, record)) return false;
        if (!record.expires) return true;
        const expiry = Date.parse(record.expires);
        return Number.isFinite(expiry) && expiry >= now;
      })
      .map(([name, record]) => name + "=" + record.value)
      .join("; ");
    if (header.length > MAX_COOKIE_HEADER_BYTES) {
      throw new Error("stored cookie header too large");
    }
    return header;
  };

  const isSessionTokenName = (name) =>
    name === "better-auth.session_token" ||
    name === "__Secure-better-auth.session_token";

  const mergeSetCookie = (header, previous) => {
    if (!header || header.length > MAX_COOKIE_STORAGE_BYTES) {
      throw new Error("session cookie header invalid");
    }
    const next = Object.assign(Object.create(null), previous);
    const cookies = header.split(
      /,(?=\\s*[A-Za-z0-9!#$%&'*+\\-.^_|~]+=)/g,
    );
    if (cookies.length > MAX_COOKIE_COUNT) {
      throw new Error("too many session cookies");
    }
    let wroteLiveSessionToken = false;
    for (const cookie of cookies) {
      const parts = cookie.split(";").map((part) => part.trim());
      const first = parts.shift() || "";
      const separator = first.indexOf("=");
      if (separator <= 0) continue;
      const name = first.slice(0, separator).trim();
      const value = first.slice(separator + 1);
      if (!COOKIE_NAME_PATTERN.test(name)) continue;
      let expiresAt = null;
      let maxAgeSeconds = null;
      for (const attribute of parts) {
        const attributeSeparator = attribute.indexOf("=");
        const attributeName = (
          attributeSeparator < 0
            ? attribute
            : attribute.slice(0, attributeSeparator)
        ).trim().toLowerCase();
        const attributeValue =
          attributeSeparator < 0
            ? ""
            : attribute.slice(attributeSeparator + 1).trim();
        if (attributeName === "max-age") {
          const seconds = Number(attributeValue);
          if (Number.isFinite(seconds)) maxAgeSeconds = seconds;
        } else if (attributeName === "expires") {
          const timestamp = Date.parse(attributeValue);
          if (Number.isFinite(timestamp)) expiresAt = timestamp;
        }
      }
      const expired =
        (maxAgeSeconds !== null && maxAgeSeconds <= 0) ||
        (expiresAt !== null && expiresAt < Date.now());
      if (expired) {
        delete next[name];
        continue;
      }
      if (!COOKIE_VALUE_PATTERN.test(value)) continue;
      const expires =
        expiresAt === null
          ? maxAgeSeconds === null
            ? null
            : new Date(Date.now() + maxAgeSeconds * 1000).toISOString()
          : new Date(expiresAt).toISOString();
      next[name] = { value, expires };
      if (isSessionTokenName(name)) wroteLiveSessionToken = true;
    }
    return { cookies: next, wroteLiveSessionToken };
  };

  const hasLiveSessionToken = (cookies) => {
    const now = Date.now();
    return Object.entries(cookies).some(([name, record]) => {
      if (!isSessionTokenName(name) || !isStoredCookie(name, record)) {
        return false;
      }
      if (!record.expires) return true;
      const expiry = Date.parse(record.expires);
      return Number.isFinite(expiry) && expiry >= now;
    });
  };

  const verify = async () => {
    if (!token || verifying) return;
    verifying = true;
    root.dataset.state = "loading";
    title.textContent = "Opening Stella";
    message.textContent = "Finishing your secure sign-in…";
    try {
      const stored = readStoredCookies();
      stored.stella_auth_bootstrap = { value: "1", expires: null };
      localStorage.setItem(COOKIE_KEY, JSON.stringify(stored));
      const response = await fetch(VERIFY_URL, {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        headers: {
          "accept": "application/json",
          "content-type": "application/json",
          "Better-Auth-Cookie": cookieHeader(stored),
        },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error("verification rejected");
      const setCookie = response.headers.get("set-better-auth-cookie");
      if (!setCookie) throw new Error("session cookie missing");
      const mirrored = mergeSetCookie(setCookie, stored);
      if (
        !mirrored.wroteLiveSessionToken ||
        !hasLiveSessionToken(mirrored.cookies)
      ) {
        throw new Error("session cookie invalid");
      }
      const serialized = JSON.stringify(mirrored.cookies);
      if (serialized.length > MAX_COOKIE_STORAGE_BYTES) {
        throw new Error("session cookie storage too large");
      }
      localStorage.setItem(COOKIE_KEY, serialized);
      localStorage.removeItem(SESSION_DATA_KEY);
      const destination = location.pathname.replace(/\\/auth\\/?$/, "/");
      location.replace(destination);
    } catch {
      showError(
        "We couldn’t complete the secure handoff. Retry, or return to stella.sh/chat for a new link.",
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
