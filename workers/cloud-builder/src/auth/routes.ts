/**
 * `/api/auth/*`: Better Auth's handler behind CORS for the trusted browser
 * origins. Browsers keep the bearer themselves (`set-auth-token`), so the
 * response exposes it; preflights allow the captcha and app-integrity headers
 * the sign-in endpoints read.
 */

import { APP_INTEGRITY_HEADER } from "@stella/contracts/app-integrity";
import { AUTH_CAPTCHA_HEADER } from "@stella/contracts/auth-challenge";
import { createAuth, trustedOrigins } from "./auth.js";

const ALLOWED_HEADERS = ["authorization", "content-type", AUTH_CAPTCHA_HEADER, APP_INTEGRITY_HEADER].join(", ");
const EXPOSED_HEADERS = "set-auth-token, set-auth-jwt";

const corsHeaders = (origin: string): Record<string, string> => ({
  "access-control-allow-origin": origin,
  "access-control-allow-credentials": "true",
  "access-control-expose-headers": EXPOSED_HEADERS,
  vary: "Origin",
});

export const handleAuthRoute = async (request: Request, env: Cloudflare.Env): Promise<Response> => {
  const origin = request.headers.get("origin");
  const allowed = origin !== null && trustedOrigins(env).includes(origin);
  if (request.method === "OPTIONS") {
    if (!allowed) return new Response(null, { status: 403, headers: { vary: "Origin" } });
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(origin),
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": ALLOWED_HEADERS,
        "access-control-max-age": "600",
      },
    });
  }
  let response: Response;
  try {
    response = await createAuth(env).handler(request);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "auth_request_failed", message: error instanceof Error ? error.message : String(error) }),
    );
    response = Response.json({ error: "Sign-in is unavailable right now. Try again shortly." }, { status: 503 });
  }
  if (!allowed) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders(origin))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
