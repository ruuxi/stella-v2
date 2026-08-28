import type {
  DeviceAuthorizationSession,
  DeviceCodeFixtureEnv,
} from "./authorization-session.js";
import { normalizeUserCode } from "./protocol.js";
import type { PublicDecisionOutcome } from "./state-machine.js";

const MAX_FORM_BYTES = 2 * 1024;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");

const nonce = (): string => {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/gu, "");
};

const htmlHeaders = (styleNonce: string): Headers =>
  new Headers({
    "cache-control": "no-store, max-age=0",
    "content-security-policy": [
      "default-src 'none'",
      `style-src 'nonce-${styleNonce}'`,
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "content-type": "text/html; charset=utf-8",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    expires: "0",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000; includeSubDomains",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });

const fixedMessage = (
  outcome: PublicDecisionOutcome | "not_found" | undefined,
): string => {
  switch (outcome) {
    case "approved":
      return "Approved. Return to Stella and choose Done.";
    case "denied":
      return "Denied. Return to Stella to cancel the request.";
    case "already_finalized":
      return "This code has already been handled.";
    case "expired":
    case "not_found":
      return "That code was not found or has expired.";
    default:
      return "Enter the code shown by Stella.";
  }
};

export const renderActivationPage = (options: {
  userCode?: string;
  outcome?: PublicDecisionOutcome | "not_found";
  styleNonce: string;
}): string => {
  const code = escapeHtml(options.userCode ?? "");
  const message = escapeHtml(fixedMessage(options.outcome));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Stella device authorization</title>
  <style nonce="${options.styleNonce}">
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0d0d0f; color: #f7f7f8; }
    main { width: min(26rem, calc(100% - 2rem)); padding: 2rem; border: 1px solid #303038; border-radius: 1rem; background: #17171b; box-sizing: border-box; }
    h1 { margin-top: 0; font-size: 1.4rem; }
    p { color: #b9b9c2; line-height: 1.5; }
    label { display: grid; gap: .5rem; font-weight: 650; }
    input { box-sizing: border-box; width: 100%; padding: .8rem; border: 1px solid #555563; border-radius: .6rem; background: #0d0d0f; color: inherit; font: inherit; letter-spacing: .12em; text-transform: uppercase; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: .75rem; margin-top: 1rem; }
    button { padding: .75rem; border: 0; border-radius: .6rem; font: inherit; font-weight: 700; cursor: pointer; }
    button[value="approve"] { background: #f7f7f8; color: #111114; }
    button[value="deny"] { background: #34343c; color: #f7f7f8; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize Stella</h1>
    <p role="status">${message}</p>
    <form method="post" action="/activate" autocomplete="off">
      <label>Device code
        <input name="user_code" value="${code}" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="9" pattern="[BCDFGHJKLMNPQRSTVWXYZbcdfghjklmnpqrstvwxyz23456789]{4}-?[BCDFGHJKLMNPQRSTVWXYZbcdfghjklmnpqrstvwxyz23456789]{4}" required autofocus>
      </label>
      <div class="actions">
        <button type="submit" name="decision" value="approve">Approve</button>
        <button type="submit" name="decision" value="deny">Deny</button>
      </div>
    </form>
  </main>
</body>
</html>`;
};

const pageResponse = (
  options: Omit<Parameters<typeof renderActivationPage>[0], "styleNonce">,
  status = 200,
  head = false,
): Response => {
  const styleNonce = nonce();
  const body = renderActivationPage({ ...options, styleNonce });
  return new Response(head ? null : body, {
    status,
    headers: htmlHeaders(styleNonce),
  });
};

const clientKey = (request: Request, suffix: string): string => {
  const ip = request.headers.get("cf-connecting-ip") ?? "unattributed";
  return `${suffix}:${ip.slice(0, 128)}`;
};

const limited = async (limiter: RateLimit, key: string): Promise<boolean> => {
  try {
    return !(await limiter.limit({ key })).success;
  } catch {
    return true;
  }
};

const exactQueryCode = (url: URL): string | undefined => {
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== "user_code")) return undefined;
  const values = url.searchParams.getAll("user_code");
  if (values.length === 0) return undefined;
  if (values.length !== 1) return undefined;
  const normalized = normalizeUserCode(values[0]);
  if (normalized === undefined) return undefined;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
};

const parseForm = async (
  request: Request,
): Promise<{ userCode: string; decision: "approve" | "deny" } | undefined> => {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/x-www-form-urlencoded"
  ) {
    return undefined;
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FORM_BYTES) {
    return undefined;
  }
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_FORM_BYTES)
    return undefined;
  const params = new URLSearchParams(body);
  const keys = [...params.keys()];
  if (
    keys.some((key) => key !== "user_code" && key !== "decision") ||
    params.getAll("user_code").length !== 1 ||
    params.getAll("decision").length !== 1
  ) {
    return undefined;
  }
  const userCode = normalizeUserCode(params.get("user_code"));
  const decision = params.get("decision");
  if (
    userCode === undefined ||
    (decision !== "approve" && decision !== "deny")
  ) {
    return undefined;
  }
  return { userCode, decision };
};

const handlePublicRequestImpl = async (
  request: Request,
  env: DeviceCodeFixtureEnv,
): Promise<Response> => {
  const url = new URL(request.url);
  if (
    (request.method === "GET" || request.method === "HEAD") &&
    url.pathname === "/activate"
  ) {
    if (
      await limited(
        env.ACTIVATION_PAGE_RATE_LIMITER,
        clientKey(request, "page"),
      )
    ) {
      return pageResponse({}, 429, request.method === "HEAD");
    }
    return pageResponse(
      { userCode: exactQueryCode(url) },
      200,
      request.method === "HEAD",
    );
  }
  if (request.method === "POST" && url.pathname === "/activate") {
    if (url.search !== "" || request.headers.get("origin") !== url.origin) {
      return pageResponse({}, 403);
    }
    if (
      await limited(
        env.ACTIVATION_DECISION_RATE_LIMITER,
        clientKey(request, "decision"),
      )
    ) {
      return pageResponse({}, 429);
    }
    const form = await parseForm(request);
    if (form === undefined) return pageResponse({}, 400);
    const stub = env.DEVICE_AUTHORIZATIONS.getByName(
      form.userCode,
    ) as DurableObjectStub<DeviceAuthorizationSession>;
    const result = await stub.publicDecision(form.decision);
    return pageResponse({ outcome: result.outcome });
  }
  return pageResponse({}, 404, request.method === "HEAD");
};

export const handlePublicRequest = async (
  request: Request,
  env: DeviceCodeFixtureEnv,
): Promise<Response> => {
  try {
    return await handlePublicRequestImpl(request, env);
  } catch {
    return pageResponse({}, 503, request.method === "HEAD");
  }
};
