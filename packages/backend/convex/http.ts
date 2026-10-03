import { APP_INTEGRITY_HEADER } from "@stella/contracts/app-integrity";
import { AUTH_CAPTCHA_HEADER } from "@stella/contracts/auth-challenge";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { corsPreflightHandler } from "./http_shared/cors";

// Route modules
import { registerAdminRoutes } from "./http_routes/admin";
import { registerDesktopReleaseRoutes } from "./http_routes/desktop_releases";
import { registerAuthHandoffRoutes } from "./http_routes/auth_handoff";
import { registerNativeOAuthRoutes } from "./http_routes/native_oauth";

import { registerAppIntegrityRoutes } from "./http_routes/app_integrity";
import { registerCloudConnectorConnectRoutes } from "./http_routes/cloud_connector_connect";
import { registerCloudIntegrationRoutes } from "./http_routes/cloud_integrations";
import { registerCloudProjectRoutes } from "./http_routes/cloud_projects";
import { registerOutboxRoutes } from "./http_routes/outbox";
import { registerXRoutes } from "./http_routes/x";
import { registerXBotRoutes } from "./http_routes/x_bot";
import { STELLA_PROMPTS_PATH, stellaPrompts } from "./stella_prompts_http";

import { registerGatewayRoutes } from "./http_routes/gateway";
import { registerStellaModelRoutes } from "./http_routes/stella_models";

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
registerDesktopReleaseRoutes(http);
registerAuthHandoffRoutes(http);
registerNativeOAuthRoutes(http);
registerXRoutes(http);
registerXBotRoutes(http);
registerOutboxRoutes(http);
registerCloudProjectRoutes(http);
registerCloudIntegrationRoutes(http);
registerCloudConnectorConnectRoutes(http);
registerAppIntegrityRoutes(http);


// ---------------------------------------------------------------------------
// Model gateway service routes (GATEWAY_SERVICE_SECRET)
// ---------------------------------------------------------------------------

registerGatewayRoutes(http);

// ---------------------------------------------------------------------------
// Stella catalog endpoints (public, CORS)
// ---------------------------------------------------------------------------

registerStellaModelRoutes(http);

http.route({
  path: STELLA_PROMPTS_PATH,
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => corsPreflightHandler(request)),
});
http.route({
  path: STELLA_PROMPTS_PATH,
  method: "GET",
  handler: stellaPrompts,
});

export default http;
