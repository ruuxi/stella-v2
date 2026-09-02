import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { corsPreflightHandler } from "./http_shared/cors";

// Route modules
import { registerAdminRoutes } from "./http_routes/admin";
import { registerDesktopReleaseRoutes } from "./http_routes/desktop_releases";
import { registerMediaRoutes } from "./http_routes/media";
import { registerMobileRoutes } from "./http_routes/mobile";
import { registerNativeOAuthRoutes } from "./http_routes/native_oauth";

import { registerMusicRoutes } from "./http_routes/music";
import { registerStripeRoutes } from "./http_routes/stripe";
import { registerSynthesisRoutes } from "./http_routes/synthesis";
import { registerVoiceRoutes } from "./http_routes/voice";
import { registerDictationRoutes } from "./http_routes/dictation";
import { registerXRoutes } from "./http_routes/x";
import { registerXBotRoutes } from "./http_routes/x_bot";
import { registerCloudAppRoutes } from "./http_routes/cloud_apps";
import { registerOutboxRoutes } from "./http_routes/outbox";
import { registerCloudAgentRoutes } from "./http_routes/cloud_agent";
import { registerCloudHomeRoutes } from "./http_routes/cloud_home";
import { registerCloudDriveRoutes } from "./http_routes/cloud_drive";
import { registerCloudProjectRoutes } from "./http_routes/cloud_projects";
import { registerCloudIntegrationRoutes } from "./http_routes/cloud_integrations";
import { registerAppsSdkRoutes } from "./http_routes/apps_sdk";
import { registerAppIntegrityRoutes } from "./http_routes/app_integrity";
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
authComponent.registerRoutes(http, createAuth, {
  cors: { exposedHeaders: ["set-auth-token"] },
});

// ---------------------------------------------------------------------------
// Feature Routes
// ---------------------------------------------------------------------------

registerAdminRoutes(http);
registerSynthesisRoutes(http);
registerDesktopReleaseRoutes(http);
registerMusicRoutes(http);
registerMediaRoutes(http);
registerMobileRoutes(http);
registerNativeOAuthRoutes(http);
registerVoiceRoutes(http);
registerDictationRoutes(http);
registerXRoutes(http);
registerXBotRoutes(http);
registerCloudAppRoutes(http);
registerOutboxRoutes(http);
registerCloudAgentRoutes(http);
registerCloudHomeRoutes(http);
registerCloudDriveRoutes(http);
registerCloudProjectRoutes(http);
registerCloudIntegrationRoutes(http);
registerAppsSdkRoutes(http);
registerAppIntegrityRoutes(http);

registerStripeRoutes(http);

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
