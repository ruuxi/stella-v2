import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { Value } from "convex/values";

type Id<_TableName extends string> = string;

export const api: PublicApiType = anyApi as unknown as PublicApiType;

export type PublicApiType = {
  "agent": {
    "device_resolver": {
      "heartbeat": FunctionReference<'mutation', 'public', { deviceName?: string | undefined; platform?: string | undefined; deviceId: string; publicKey: string; signedAtMs: number; signature: string; }, any, string | undefined>;
      "registerDevice": FunctionReference<'mutation', 'public', { deviceName?: string | undefined; platform?: string | undefined; deviceId: string; }, any, string | undefined>;
      "goOffline": FunctionReference<'mutation', 'public', { deviceId: string; }, any, string | undefined>;
    };
    "local_runtime": {
      "executeTool": FunctionReference<'action', 'public', { conversationId?: Id<'conversations'> | undefined; agentType?: string | undefined; toolArgs?: Value | undefined; toolName: string; }, any, string | undefined>;
      "webSearch": FunctionReference<'action', 'public', { conversationId?: Id<'conversations'> | undefined; url?: string | undefined; category?: string | undefined; agentType?: string | undefined; prompt?: string | undefined; query?: string | undefined; format?: 'text' | 'markdown' | 'html' | undefined; }, any, string | undefined>;
      "shopifySearchProducts": FunctionReference<'action', 'public', { limit?: number | undefined; context?: string | undefined; savedCatalog?: string | undefined; query: string; }, any, string | undefined>;
      "shopifyDebugSearchProducts": FunctionReference<'action', 'public', { limit?: number | undefined; context?: string | undefined; savedCatalog?: string | undefined; query: string; }, any, string | undefined>;
      "shopifyGetProductDetails": FunctionReference<'action', 'public', { productId: string; }, any, string | undefined>;
      "shopifyCreateCheckout": FunctionReference<'action', 'public', { merchantOrigin: string; lines: { quantity: number; variantId: string; }[]; }, any, string | undefined>;
      "shopifyUpdateCheckout": FunctionReference<'action', 'public', { mcpEndpoint: string; checkoutId: string; lines: { quantity: number; variantId: string; }[]; }, any, string | undefined>;
      "shopifyCancelCheckout": FunctionReference<'action', 'public', { mcpEndpoint: string; checkoutId: string; }, any, string | undefined>;
      "fashionRegisterOutfit": FunctionReference<'action', 'public', { stylePrompt?: string | undefined; themeDescription?: string | undefined; tryOnPrompt?: string | undefined; ordinal: number; batchId: string; themeLabel: string; products: { currency?: string | undefined; price?: number | undefined; imageUrl?: string | undefined; productUrl?: string | undefined; checkoutUrl?: string | undefined; vendor?: string | undefined; title: string; slot: string; productId: string; variantId: string; merchantOrigin: string; }[]; }, any, string | undefined>;
      "fashionMarkOutfitReady": FunctionReference<'action', 'public', { tryOnImagePath?: string | undefined; tryOnImageUrl?: string | undefined; outfitId: Id<'fashion_outfits'>; }, any, string | undefined>;
      "fashionMarkOutfitFailed": FunctionReference<'action', 'public', { errorMessage: string; outfitId: Id<'fashion_outfits'>; }, any, string | undefined>;
      "fashionGetOrchestratorContext": FunctionReference<'action', 'public', {}, any, string | undefined>;
    };
    "prompt_builder": {
      "fetchAgentContextForRuntime": FunctionReference<'action', 'public', { threadId?: Id<'threads'> | undefined; platform?: string | undefined; maxHistoryMessages?: number | undefined; timezone?: string | undefined; conversationId: Id<'conversations'>; agentType: string; runId: string; }, any, string | undefined>;
      "fetchLocalAgentContextForRuntime": FunctionReference<'action', 'public', { platform?: string | undefined; timezone?: string | undefined; agentType: string; runId: string; }, any, string | undefined>;
    };
  };
  "auth": {
    "getAuthUser": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getCurrentUser": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "revokeActiveSessions": FunctionReference<'action', 'public', {}, any, string | undefined>;
  };
  "billing": {
    "getSubscriptionStatus": FunctionReference<'query', 'public', { now?: number | undefined; }, any, string | undefined>;
    "createCheckoutSession": FunctionReference<'action', 'public', { source?: string | undefined; appStoreCountry?: string | undefined; plan: 'go' | 'pro'; returnUrl: string; }, any, string | undefined>;
    "getUsageCreditPurchaseOptions": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getUsageCreditStatus": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "createUsageCreditCheckoutSession": FunctionReference<'action', 'public', { amountCents: number; returnUrl: string; }, any, string | undefined>;
    "createBillingPortalSession": FunctionReference<'action', 'public', { returnUrl: string; }, any, string | undefined>;
    "getCurrentPlan": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
  "channels": {
    "connector_delivery": {
      "claimRemoteTurn": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; requestId: string; }, any, string | undefined>;
      "cancelRemoteTurn": FunctionReference<'mutation', 'public', { requestId: string; }, any, string | undefined>;
      "completeRemoteTurn": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
      "sendConnectorFollowup": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
    };
  };
  "conversations": {
    "getOrCreateDefaultConversation": FunctionReference<'mutation', 'public', { title?: string | undefined; }, any, string | undefined>;
    "createConversation": FunctionReference<'mutation', 'public', { title?: string | undefined; }, any, string | undefined>;
  };
  "data": {
    "attachments": {
      "createFromDataUrl": FunctionReference<'action', 'public', { conversationId: Id<'conversations'>; deviceId: string; dataUrl: string; }, any, string | undefined>;
    };
    "canvas_shares": {
      "listMine": FunctionReference<'query', 'public', {}, any, string | undefined>;
    };
    "canvas_shares_actions": {
      "publish": FunctionReference<'action', 'public', { title?: string | undefined; html: string; }, any, string | undefined>;
      "revoke": FunctionReference<'action', 'public', { slug: string; }, any, string | undefined>;
    };
    "desktop_releases": {
      "currentDesktopRelease": FunctionReference<'query', 'public', { platform: string; }, any, string | undefined>;
    };
    "emoji_pack_generation": {
      "generatePack": FunctionReference<'action', 'public', { prompt: string; visibility: 'public' | 'unlisted' | 'private'; }, any, string | undefined>;
    };
    "emoji_pack_grid": {
      "getManifest": FunctionReference<'query', 'public', {}, any, string | undefined>;
    };
    "emoji_pack_uploads": {
      "createUploadUrl": FunctionReference<'action', 'public', { contentType?: string | undefined; packId: string; sheetSha256s: string[]; }, any, string | undefined>;
    };
    "emoji_packs": {
      "listPublicPage": FunctionReference<'query', 'public', { search?: string | undefined; sort?: 'name' | 'installs' | undefined; tag?: string | undefined; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "listTagFacets": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listMine": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getByPackId": FunctionReference<'query', 'public', { packId: string; }, any, string | undefined>;
      "createPack": FunctionReference<'mutation', 'public', { description?: string | undefined; prompt?: string | undefined; coverUrl?: string | undefined; displayName: string; packId: string; coverEmoji: string; sheetUrls: string[]; visibility: 'public' | 'unlisted' | 'private'; }, any, string | undefined>;
      "setVisibility": FunctionReference<'mutation', 'public', { packId: string; visibility: 'public' | 'unlisted' | 'private'; }, any, string | undefined>;
      "deletePack": FunctionReference<'mutation', 'public', { packId: string; }, any, string | undefined>;
      "recordInstall": FunctionReference<'mutation', 'public', { packId: string; }, any, string | undefined>;
    };
    "fashion": {
      "getFashionFeatureStatus": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getProfile": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setProfile": FunctionReference<'mutation', 'public', { displayName?: string | undefined; gender?: string | undefined; sizes?: Record<string, string> | undefined; stylePreferences?: string | undefined; }, any, string | undefined>;
      "setBodyPhotoFlag": FunctionReference<'mutation', 'public', { bodyPhotoMimeType?: string | undefined; hasBodyPhoto: boolean; }, any, string | undefined>;
      "listOutfits": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
      "listOutfitsByBatch": FunctionReference<'query', 'public', { batchId: string; }, any, string | undefined>;
      "deleteOutfit": FunctionReference<'mutation', 'public', { outfitId: Id<'fashion_outfits'>; }, any, string | undefined>;
      "listLikes": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
      "toggleLike": FunctionReference<'mutation', 'public', { currency?: string | undefined; imageUrl?: string | undefined; productUrl?: string | undefined; vendor?: string | undefined; priceCents?: number | undefined; title: string; productId: string; variantId: string; merchantOrigin: string; }, any, string | undefined>;
      "listCart": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "addToCart": FunctionReference<'mutation', 'public', { currency?: string | undefined; quantity?: number | undefined; imageUrl?: string | undefined; productUrl?: string | undefined; checkoutUrl?: string | undefined; vendor?: string | undefined; priceCents?: number | undefined; title: string; productId: string; variantId: string; merchantOrigin: string; }, any, string | undefined>;
      "removeFromCart": FunctionReference<'mutation', 'public', { cartItemId: Id<'fashion_cart_items'>; }, any, string | undefined>;
      "setCartQuantity": FunctionReference<'mutation', 'public', { quantity: number; cartItemId: Id<'fashion_cart_items'>; }, any, string | undefined>;
    };
    "integrations": {
      "listStoreIntegrations": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "createXConnectUrl": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "listXConnections": FunctionReference<'query', 'public', {}, any, string | undefined>;
    };
    "preferences": {
      "getAccountMode": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setAccountMode": FunctionReference<'mutation', 'public', { mode: 'private_local' | 'connected'; }, any, string | undefined>;
      "getSyncMode": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setSyncMode": FunctionReference<'mutation', 'public', { mode: 'on' | 'off'; }, any, string | undefined>;
      "setPreferredBrowser": FunctionReference<'mutation', 'public', { browser: 'none' | 'arc' | 'brave' | 'chrome' | 'edge' | 'firefox' | 'opera' | 'safari' | 'vivaldi'; }, any, string | undefined>;
      "getLocale": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setLocale": FunctionReference<'mutation', 'public', { locale: 'id' | 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'nl' | 'ru' | 'ja' | 'zh-Hans' | 'zh-Hant' | 'ko' | 'pl' | 'sv' | 'nb' | 'da' | 'fi' | 'cs' | 'el' | 'tr' | 'ro' | 'hu' | 'ar' | 'hi' | 'vi' | 'th' | 'he'; }, any, string | undefined>;
    };
    "secrets": {
      "createSecret": FunctionReference<'mutation', 'public', { metadata?: Value | undefined; provider: string; label: string; plaintext: string; }, any, string | undefined>;
      "listSecrets": FunctionReference<'query', 'public', { provider?: string | undefined; }, any, string | undefined>;
      "deleteSecret": FunctionReference<'mutation', 'public', { secretId: Id<'secrets'>; }, any, string | undefined>;
    };
  };
  "debug_identity_probe": {
    "probeIdentityClaims": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
  "device_identity": {
    "adoptDeviceIdentitySuccession": FunctionReference<'mutation', 'public', { deviceId: string; previousDeviceId: string; }, any, string | undefined>;
  };
  "events": {
    "subscribeRemoteTurnRequestsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "subscribeRemoteTurnCancelsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "isRemoteTurnClaimed": FunctionReference<'query', 'public', { requestId: string; }, any, string | undefined>;
  };
  "feedback": {
    "submitFeedback": FunctionReference<'mutation', 'public', { platform?: string | undefined; appVersion?: string | undefined; message: string; }, any, string | undefined>;
  };
  "media_jobs": {
    "getByJobId": FunctionReference<'query', 'public', { jobId: string; }, any, string | undefined>;
    "listSucceededSince": FunctionReference<'query', 'public', { limit?: number | undefined; includeLogs?: boolean | undefined; since: number; }, any, string | undefined>;
    "listFailedSince": FunctionReference<'query', 'public', { limit?: number | undefined; includeLogs?: boolean | undefined; since: number; }, any, string | undefined>;
  };
  "mobile_access": {
    "getPhoneAccessState": FunctionReference<'query', 'public', { desktopDeviceId: string; }, any, string | undefined>;
    "createPairingSession": FunctionReference<'mutation', 'public', { desktopDeviceId: string; }, any, string | undefined>;
    "revokePairedMobileDevice": FunctionReference<'mutation', 'public', { desktopDeviceId: string; mobileDeviceId: string; }, any, string | undefined>;
    "watchIncomingConnectIntent": FunctionReference<'query', 'public', { nowMs?: number | undefined; desktopDeviceId: string; }, any, string | undefined>;
    "acknowledgeConnectIntent": FunctionReference<'mutation', 'public', { intentId: Id<'mobile_connect_intents'>; }, any, string | undefined>;
  };
  "mobile_bridge": {
    "registerDesktopBridge": FunctionReference<'mutation', 'public', { platform?: string | undefined; desktopPublicKey?: string | undefined; deviceId: string; baseUrls: string[]; }, any, string | undefined>;
  };
  "mobile_chat": {
    "sendChat": FunctionReference<'action', 'public', { model?: string | undefined; message: string; desktopDeviceId: string; mobileDeviceId: string; pairSecret: string; }, any, string | undefined>;
    "cancelChat": FunctionReference<'action', 'public', { requestId: string; desktopDeviceId: string; mobileDeviceId: string; pairSecret: string; }, any, string | undefined>;
  };
  "mobile_push": {
    "sendActivityNotification": FunctionReference<'action', 'public', { kind: 'completed' | 'failed' | 'started'; }, any, string | undefined>;
    "sendWalletSpendNotification": FunctionReference<'action', 'public', { merchantName: string; amountCents: number; }, any, string | undefined>;
  };
  "r2_files": {
    "generateUploadUrl": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
    "syncMetadata": FunctionReference<'mutation', 'public', { key: string; }, any, string | undefined>;
  };
  "reset": {
    "resetAllUserData": FunctionReference<'action', 'public', {}, any, string | undefined>;
  };
  "scheduling": {
    "cron_jobs": {
      "completeCronTurnResult": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
    };
  };
  "stella_models": {
    "getModelCatalogUpdatedAt": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
} & Record<string, any>;
