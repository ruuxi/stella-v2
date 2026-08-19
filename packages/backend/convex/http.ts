import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { authComponent, createAuth } from "./auth";
import { corsPreflightHandler } from "./http_shared/cors";

// Route modules
import { registerAdminRoutes } from "./http_routes/admin";
import { registerBackupRoutes } from "./http_routes/backups";
import { registerDesktopReleaseRoutes } from "./http_routes/desktop_releases";
import { registerMediaRoutes } from "./http_routes/media";
import { registerMobileRoutes } from "./http_routes/mobile";
import { registerNativeOAuthRoutes } from "./http_routes/native_oauth";
import { registerPetRoutes } from "./http_routes/pets";

import { registerMusicRoutes } from "./http_routes/music";
import { registerStripeRoutes } from "./http_routes/stripe";
import { registerSynthesisRoutes } from "./http_routes/synthesis";
import { registerVoiceRoutes } from "./http_routes/voice";
import { registerDictationRoutes } from "./http_routes/dictation";
import { registerXRoutes } from "./http_routes/x";

// Stella provider endpoints
import {
  STELLA_ANTHROPIC_MESSAGES_PATH,
  STELLA_CROF_CHAT_COMPLETIONS_PATH,
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
  STELLA_XAI_CHAT_COMPLETIONS_PATH,
  STELLA_XAI_RESPONSES_PATH,
  STELLA_RELAY_PATH_PREFIX,
  stellaProviderModels,
  stellaProviderOptions,
  stellaProviderRelay,
} from "./stella_provider";

const http = httpRouter();

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

authComponent.registerRoutes(http, createAuth, { cors: true });

// ---------------------------------------------------------------------------
// Feature Routes
// ---------------------------------------------------------------------------

registerAdminRoutes(http);
registerSynthesisRoutes(http);
registerBackupRoutes(http);
registerDesktopReleaseRoutes(http);
registerMusicRoutes(http);
registerMediaRoutes(http);
registerMobileRoutes(http);
registerNativeOAuthRoutes(http);
registerPetRoutes(http);
registerVoiceRoutes(http);
registerDictationRoutes(http);
registerXRoutes(http);

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
  path: STELLA_MODELS_PATH,
  method: "GET",
  handler: stellaProviderModels,
});

for (const [path, provider] of [
  [STELLA_ANTHROPIC_MESSAGES_PATH, "anthropic"],
  [STELLA_OPENAI_CHAT_COMPLETIONS_PATH, "openai"],
  [STELLA_OPENAI_RESPONSES_PATH, "openai"],
  [STELLA_FIREWORKS_RESPONSES_PATH, "fireworks"],
  [STELLA_DEEPSEEK_RESPONSES_PATH, "deepseek"],
  [STELLA_DEEPSEEK_CHAT_COMPLETIONS_PATH, "deepseek"],
  [STELLA_CROF_CHAT_COMPLETIONS_PATH, "crof"],
  [STELLA_XAI_CHAT_COMPLETIONS_PATH, "xai"],
  [STELLA_XAI_RESPONSES_PATH, "xai"],
  [STELLA_OPENROUTER_CHAT_COMPLETIONS_PATH, "openrouter"],
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
