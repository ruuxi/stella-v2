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
import { registerCloudAgentRoutes } from "./http_routes/cloud_agent";
import { registerCloudHomeRoutes } from "./http_routes/cloud_home";
import { registerCloudDriveRoutes } from "./http_routes/cloud_drive";
import { registerCloudProjectRoutes } from "./http_routes/cloud_projects";
import { registerCloudIntegrationRoutes } from "./http_routes/cloud_integrations";
import { registerAppsSdkRoutes } from "./http_routes/apps_sdk";
import { registerExecutionPresenceRoutes } from "./http_routes/execution_presence";
import { STELLA_PROMPTS_PATH, stellaPrompts } from "./stella_prompts_http";

// Stella provider endpoints
import {
  STELLA_ANTHROPIC_MESSAGES_PATH,
  STELLA_CLOUD_MODEL_PATH,
  STELLA_CROF_CHAT_COMPLETIONS_PATH,
  STELLA_WAFER_CHAT_COMPLETIONS_PATH,
  STELLA_DEEPSEEK_CHAT_COMPLETIONS_PATH,
  STELLA_DEEPSEEK_RESPONSES_PATH,
  STELLA_FIREWORKS_RESPONSES_PATH,
  STELLA_GOOGLE_MODELS_PATH_PREFIX,
  STELLA_MODELS_PATH,
  STELLA_OPENAI_CHAT_COMPLETIONS_PATH,
  STELLA_OPENAI_RESPONSES_PATH,
  STELLA_META_CHAT_COMPLETIONS_PATH,
  STELLA_META_RESPONSES_PATH,
  STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH,
  STELLA_OPENROUTER_RESPONSES_PATH,
  STELLA_XAI_CHAT_COMPLETIONS_PATH,
  STELLA_XAI_RESPONSES_PATH,
  STELLA_RELAY_PATH_PREFIX,
  stellaProviderModels,
  stellaProviderCloudModel,
  stellaProviderCancel,
  stellaProviderOptions,
  stellaProviderRelay,
  stellaProviderResume,
} from "./stella_provider";

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
registerCloudAgentRoutes(http);
registerCloudHomeRoutes(http);
registerCloudDriveRoutes(http);
registerCloudProjectRoutes(http);
registerCloudIntegrationRoutes(http);
registerAppsSdkRoutes(http);
registerExecutionPresenceRoutes(http);

registerStripeRoutes(http);

// ---------------------------------------------------------------------------
// Stella provider endpoints
// ---------------------------------------------------------------------------

const stellaModelsOptionsHandler = httpAction(async (_ctx, request) =>
  corsPreflightHandler(request),
);

http.route({
  path: STELLA_MODELS_PATH,
  method: "OPTIONS",
  handler: stellaModelsOptionsHandler,
});
http.route({
  path: STELLA_PROMPTS_PATH,
  method: "OPTIONS",
  handler: stellaModelsOptionsHandler,
});
http.route({
  path: STELLA_PROMPTS_PATH,
  method: "GET",
  handler: stellaPrompts,
});
http.route({
  path: STELLA_MODELS_PATH,
  method: "GET",
  handler: stellaProviderModels,
});
http.route({
  path: STELLA_CLOUD_MODEL_PATH,
  method: "POST",
  handler: stellaProviderCloudModel,
});

for (const [path, provider] of [
  [STELLA_ANTHROPIC_MESSAGES_PATH, "anthropic"],
  [STELLA_OPENAI_CHAT_COMPLETIONS_PATH, "openai"],
  [STELLA_OPENAI_RESPONSES_PATH, "openai"],
  [STELLA_FIREWORKS_RESPONSES_PATH, "fireworks"],
  [STELLA_DEEPSEEK_RESPONSES_PATH, "deepseek"],
  [STELLA_DEEPSEEK_CHAT_COMPLETIONS_PATH, "deepseek"],
  [STELLA_CROF_CHAT_COMPLETIONS_PATH, "crof"],
  [STELLA_WAFER_CHAT_COMPLETIONS_PATH, "wafer"],
  [STELLA_XAI_CHAT_COMPLETIONS_PATH, "xai"],
  [STELLA_XAI_RESPONSES_PATH, "xai"],
  [STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH, "openrouter"],
  [STELLA_OPENROUTER_RESPONSES_PATH, "openrouter"],
  [STELLA_META_CHAT_COMPLETIONS_PATH, "meta"],
  [STELLA_META_RESPONSES_PATH, "meta"],
] as const) {
  http.route({
    path,
    method: "OPTIONS",
    handler: stellaProviderOptions,
  });
  http.route({
    path,
    method: "POST",
    handler: stellaProviderRelay(provider),
  });
}

http.route({
  pathPrefix: STELLA_RELAY_PATH_PREFIX,
  method: "OPTIONS",
  handler: stellaProviderOptions,
});
http.route({
  pathPrefix: STELLA_RELAY_PATH_PREFIX,
  method: "POST",
  handler: stellaProviderRelay(),
});
http.route({
  pathPrefix: STELLA_RELAY_PATH_PREFIX,
  method: "GET",
  handler: stellaProviderResume,
});
http.route({
  pathPrefix: STELLA_RELAY_PATH_PREFIX,
  method: "DELETE",
  handler: stellaProviderCancel,
});
http.route({
  pathPrefix: STELLA_GOOGLE_MODELS_PATH_PREFIX,
  method: "OPTIONS",
  handler: stellaProviderOptions,
});
http.route({
  pathPrefix: STELLA_GOOGLE_MODELS_PATH_PREFIX,
  method: "POST",
  handler: stellaProviderRelay("google"),
});

export default http;
