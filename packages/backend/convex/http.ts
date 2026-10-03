import { APP_INTEGRITY_HEADER } from "@stella/contracts/app-integrity";
import { AUTH_CAPTCHA_HEADER } from "@stella/contracts/auth-challenge";
import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

// Route modules
import { registerAdminRoutes } from "./http_routes/admin";
import { registerAuthHandoffRoutes } from "./http_routes/auth_handoff";
import { registerAppIntegrityRoutes } from "./http_routes/app_integrity";
import { registerGatewayRoutes } from "./http_routes/gateway";

const http = httpRouter();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

// `exposedHeaders` is required for `set-auth-token` to be readable by browser
// clients: the convex-helpers CORS wrapper SETS Access-Control-Expose-Headers
// on the way out, clobbering the value the bearer plugin adds. Without this
// the header is present on the response but unreadable from JS.
//
// `allowedHeaders` must list the captcha header: the browser web chat sends
// its Turnstile proof as `x-captcha-response` on anonymous sign-in, and the
// component's default preflight only allows Content-Type/Authorization, so
// the request never leaves the browser (CORS preflight failure).
authComponent.registerRoutes(http, createAuth, {
  cors: {
    allowedHeaders: [AUTH_CAPTCHA_HEADER, APP_INTEGRITY_HEADER],
    exposedHeaders: ["set-auth-token"],
  },
});

// ---------------------------------------------------------------------------
// Feature Routes
// ---------------------------------------------------------------------------

registerAdminRoutes(http);
registerAuthHandoffRoutes(http);
registerAppIntegrityRoutes(http);

// ---------------------------------------------------------------------------
// Model gateway service routes (GATEWAY_SERVICE_SECRET)
// ---------------------------------------------------------------------------

registerGatewayRoutes(http);

export default http;
