import { anyApi } from "convex/server";
import type { FunctionReference } from "convex/server";
import type { Value } from "convex/values";

type Id<_TableName extends string> = string;

export const api: PublicApiType = anyApi as unknown as PublicApiType;

export type PublicApiType = {
  "agent": {
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
  "auth_migration": {
    "getMyOwnershipMigrationStatus": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "retryMyLatestFailedOwnershipMigration": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
  };
  "billing": {
    "getSubscriptionStatus": FunctionReference<'query', 'public', { now?: number | undefined; }, any, string | undefined>;
    "createCheckoutSession": FunctionReference<'action', 'public', { source?: string | undefined; appStoreCountry?: string | undefined; requestId: string; plan: 'go' | 'pro'; returnUrl: string; }, any, string | undefined>;
    "getUsageCreditPurchaseOptions": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getUsageCreditStatus": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "createUsageCreditCheckoutSession": FunctionReference<'action', 'public', { requestId: string; amountCents: number; returnUrl: string; }, any, string | undefined>;
    "createBillingPortalSession": FunctionReference<'action', 'public', { requestId: string; returnUrl: string; }, any, string | undefined>;
    "getCurrentPlan": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
  "channels": {
    "connector_delivery": {
      "claimRemoteTurn": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; deviceId: string; requestId: string; attemptId: string; }, any, string | undefined>;
      "heartbeatRemoteTurn": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; deviceId: string; requestId: string; attemptId: string; }, any, string | undefined>;
      "cancelRemoteTurn": FunctionReference<'mutation', 'public', { requestId: string; }, any, string | undefined>;
      "completeRemoteTurn": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; text: string; deviceId: string; requestId: string; attemptId: string; }, any, string | undefined>;
      "finishRemoteTurnAttempt": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; deviceId: string; requestId: string; attemptId: string; outcome: 'failed' | 'aborted' | 'timed_out'; }, any, string | undefined>;
      "sendConnectorFollowup": FunctionReference<'mutation', 'public', { deviceId?: string | undefined; conversationId: Id<'conversations'>; text: string; requestId: string; }, any, string | undefined>;
    };
  };
  "cloud_apps": {
    "confirmMySessionIdentity": FunctionReference<'query', 'public', { expectedSubject: string; identityRevision: number; }, any, string | undefined>;
    "getMyCloudConversationIdentity": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "createMyConversation": FunctionReference<'mutation', 'public', { execution?: { model: string; provider: 'anthropic' | 'stella' | 'openai-codex'; engine: 'anthropic' | 'stella' | 'openai-codex'; reasoningEffort: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; } | undefined; title?: string | undefined; clientCreateId: string; expectedOwnerGeneration: string; }, any, string | undefined>;
    "getMyConversation": FunctionReference<'query', 'public', { conversationId: string; }, any, string | undefined>;
    "listMyConversations": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getMyConversationHistorySnapshot": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "listMyConversationsPage": FunctionReference<'query', 'public', { snapshotUpdatedAt: number; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
    "listMyApps": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getCloudRealtimeConfig": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "listMyAppBuilds": FunctionReference<'query', 'public', { appId: string; }, any, string | undefined>;
    "getMyCloudLimits": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "startCloudChat": FunctionReference<'mutation', 'public', { attachments?: string[] | undefined; execution?: { model: string; provider: 'anthropic' | 'stella' | 'openai-codex'; engine: 'anthropic' | 'stella' | 'openai-codex'; reasoningEffort: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; } | undefined; conversationId?: string | undefined; appId?: string | undefined; clientMsgId?: string | undefined; locale?: string | undefined; prompt: string; expectedOwnerGeneration: string; }, any, string | undefined>;
    "deleteMyConversation": FunctionReference<'action', 'public', { conversationId: string; }, any, string | undefined>;
    "spawnCloudAgentFromDesktop": FunctionReference<'mutation', 'public', { execution?: { model: string; provider: 'anthropic' | 'stella' | 'openai-codex'; engine: 'anthropic' | 'stella' | 'openai-codex'; reasoningEffort: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; } | undefined; conversationId?: string | undefined; originDeviceId?: string | undefined; originConversationId?: string | undefined; ownerGeneration: string; description: string; prompt: string; workspace: string; clientMsgId: string; }, any, string | undefined>;
    "continueMyCloudAgentFromDesktop": FunctionReference<'mutation', 'public', { threadId: string; ownerGeneration: string; description: string; prompt: string; originDeviceId: string; originConversationId: string; expectedAttemptGeneration: number; expectedTerminalUpdatedAt: number; controlRequestId: string; }, any, string | undefined>;
    "getMyCloudAgentThreadControl": FunctionReference<'query', 'public', { threadId: string; ownerGeneration: string; originDeviceId: string; originConversationId: string; }, any, string | undefined>;
    "cancelMyCloudAgentThread": FunctionReference<'action', 'public', { threadId: string; ownerGeneration: string; originDeviceId: string; originConversationId: string; expectedAttemptGeneration: number; controlRequestId: string; expectedThreadUpdatedAt: number; }, any, string | undefined>;
    "listMyAgentThreads": FunctionReference<'query', 'public', { conversationId: string; }, any, string | undefined>;
    "listMyAgentThreadsPage": FunctionReference<'query', 'public', { conversationId: string; identityRevision: number; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
    "listMyRunningAgentThreads": FunctionReference<'query', 'public', { conversationId: string; identityRevision: number; }, any, string | undefined>;
    "listMyRecentAgentThreads": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
    "listMyDeviceAgentThreads": FunctionReference<'query', 'public', { limit?: number | undefined; sinceUpdatedAt?: number | undefined; ownerGeneration: string; originDeviceId: string; }, any, string | undefined>;
    "acknowledgeMyDeviceAgentThreadDelivery": FunctionReference<'mutation', 'public', { threadId: string; ownerGeneration: string; attemptGeneration: number; originDeviceId: string; terminalUpdatedAt: number; }, any, string | undefined>;
    "applyMyBuild": FunctionReference<'action', 'public', { buildId: string; }, any, string | undefined>;
    "deleteMyApp": FunctionReference<'action', 'public', { appId: string; }, any, string | undefined>;
    "publishMyAppOperations": FunctionReference<'mutation', 'public', { appId: string; manifestJson: string; }, any, string | undefined>;
    "listPendingOpInvocations": FunctionReference<'query', 'public', { appId: string; }, any, string | undefined>;
    "claimOpInvocation": FunctionReference<'mutation', 'public', { invocationId: string; }, any, string | undefined>;
    "completeOpInvocation": FunctionReference<'mutation', 'public', { resultJson?: string | undefined; errorMessage?: string | undefined; invocationId: string; ok: boolean; }, any, string | undefined>;
  };
  "cloud_conversation_edits": {
    "forkMyConversation": FunctionReference<'action', 'public', { requestId: string; sourceConversationId: string; throughSeq: number; expectedEpoch: number; expectedLastSeq: number; }, any, string | undefined>;
    "rewindMyConversation": FunctionReference<'action', 'public', { conversationId: string; requestId: string; throughSeq: number; expectedEpoch: number; expectedLastSeq: number; activeTurnPolicy: 'conflict' | 'cancel'; }, any, string | undefined>;
  };
  "cloud_deployments": {
    "getMyActiveInteriorManifest": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "listMyInteriorBuilds": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
    "ensureMyInteriorStableRoute": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
    "rotateMyInteriorStableRoute": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
    "promoteMyInteriorBuild": FunctionReference<'mutation', 'public', { buildId: string; expectedRouteRevision: number; }, any, string | undefined>;
    "rollbackMyInteriorBuild": FunctionReference<'mutation', 'public', { expectedRouteRevision: number; }, any, string | undefined>;
  };
  "cloud_dream": {
    "getMyDreamStatus": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
  "cloud_drive": {
    "prepareDriveUpload": FunctionReference<'action', 'public', { contentType?: string | undefined; sizeBytes: number; path: string; }, any, string | undefined>;
    "finalizeDriveUpload": FunctionReference<'action', 'public', { source?: string | undefined; contentType?: string | undefined; path: string; uploadId: string; }, any, string | undefined>;
    "listMyDriveFiles": FunctionReference<'query', 'public', { limit?: number | undefined; prefix?: string | undefined; }, any, string | undefined>;
    "getMyDriveUsage": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getMyDriveFileUrl": FunctionReference<'action', 'public', { path: string; }, any, string | undefined>;
    "deleteMyDriveFile": FunctionReference<'action', 'public', { path: string; }, any, string | undefined>;
  };
  "cloud_engines": {
    "startEngineConnect": FunctionReference<'action', 'public', { provider: string; }, any, string | undefined>;
    "finishEngineConnect": FunctionReference<'action', 'public', { connectId: string; pastedInput: string; }, any, string | undefined>;
    "disconnectEngine": FunctionReference<'mutation', 'public', { provider: string; }, any, string | undefined>;
    "listMyEngineConnections": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "activateImportedCredential": FunctionReference<'mutation', 'public', { credentialId: Id<'cloud_llm_credentials'>; }, any, string | undefined>;
    "activateImportedEngineSettings": FunctionReference<'mutation', 'public', { settingsId: Id<'cloud_engine_settings'>; }, any, string | undefined>;
    "setMyCloudEngine": FunctionReference<'mutation', 'public', { engine: string; }, any, string | undefined>;
    "setMyCloudExecution": FunctionReference<'mutation', 'public', { execution: { model: string; provider: 'anthropic' | 'stella' | 'openai-codex'; engine: 'anthropic' | 'stella' | 'openai-codex'; reasoningEffort: 'default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; }; }, any, string | undefined>;
  };
  "cloud_memory": {
    "getMyMemoryPreference": FunctionReference<'query', 'public', { expectedSubject: string; }, any, string | undefined>;
    "setMyMemoryEnabled": FunctionReference<'mutation', 'public', { requestId: string; memoryEnabled: boolean; expectedRevision: number; expectedSubject: string; expectedOwnerGeneration: string; }, any, string | undefined>;
    "listMyMemoryDocuments": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
    "getMyMemoryDocument": FunctionReference<'query', 'public', { kind: 'profile' | 'memory' | 'memory_map' | 'core_memory' | 'personality' | 'imported_markdown' | 'user_markdown' | 'archive'; name: string; }, any, string | undefined>;
  };
  "cloud_memory_lifecycle": {
    "getMyMemoryWipeStatus": FunctionReference<'query', 'public', { expectedSubject: string; }, any, string | undefined>;
    "startMyMemoryWipe": FunctionReference<'mutation', 'public', { requestId: string; expectedSubject: string; expectedOwnerGeneration: string; expectedMemoryEpoch: string; }, any, string | undefined>;
    "authorizeMyMemoryReimport": FunctionReference<'mutation', 'public', { requestId: string; expectedSubject: string; expectedOwnerGeneration: string; expectedMemoryEpoch: string; }, any, string | undefined>;
  };
  "cloud_projects": {
    "listMyProjects": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getMyProject": FunctionReference<'query', 'public', { slug?: string | undefined; projectId?: string | undefined; }, any, string | undefined>;
    "createMyProject": FunctionReference<'mutation', 'public', { slug?: string | undefined; remoteUrl?: string | undefined; installationId?: string | undefined; defaultBranch?: string | undefined; name: string; }, any, string | undefined>;
    "renameMyProject": FunctionReference<'mutation', 'public', { name: string; projectId: string; }, any, string | undefined>;
    "setMyProjectRemote": FunctionReference<'mutation', 'public', { installationId?: string | undefined; defaultBranch?: string | undefined; projectId: string; remoteUrl: string; }, any, string | undefined>;
    "deleteMyProject": FunctionReference<'action', 'public', { projectId: string; }, any, string | undefined>;
    "listMyGithubInstallations": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "startGithubAppInstall": FunctionReference<'action', 'public', {}, any, string | undefined>;
    "finishGithubConnect": FunctionReference<'mutation', 'public', { connectCode: string; }, any, string | undefined>;
    "disconnectGithubInstallation": FunctionReference<'mutation', 'public', { installationId: string; }, any, string | undefined>;
    "listMyGithubRepositories": FunctionReference<'action', 'public', { installationId?: string | undefined; }, any, string | undefined>;
  };
  "cloud_skills": {
    "authorizeMySkill": FunctionReference<'mutation', 'public', { versionId: string; skillId: string; allowedAgentTypes: ('orchestrator' | 'general')[]; allowedToolNames: string[]; expectedOwnerGeneration: string; expectedAuthorizationRevision: number; }, any, string | undefined>;
    "revokeMySkill": FunctionReference<'mutation', 'public', { skillId: string; expectedOwnerGeneration: string; expectedAuthorizationRevision: number; }, any, string | undefined>;
    "setMySkillEnabled": FunctionReference<'mutation', 'public', { enabled: boolean; skillId: string; expectedRevision: number; expectedOwnerGeneration: string; }, any, string | undefined>;
    "listMySkills": FunctionReference<'query', 'public', { clientScope: string; }, any, string | undefined>;
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
      "listMine": FunctionReference<'query', 'public', { limit?: number | undefined; snapshotAt: number; }, any, string | undefined>;
    };
    "canvas_shares_actions": {
      "publish": FunctionReference<'action', 'public', { title?: string | undefined; html: string; }, any, string | undefined>;
      "revoke": FunctionReference<'action', 'public', { slug: string; }, any, string | undefined>;
    };
    "desktop_releases": {
      "currentDesktopRelease": FunctionReference<'query', 'public', { platform: string; }, any, string | undefined>;
    };
    "emoji_pack_generation": {
      "generatePack": FunctionReference<'action', 'public', { visibility: 'public' | 'unlisted' | 'private'; prompt: string; }, any, string | undefined>;
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
      "createPack": FunctionReference<'mutation', 'public', { description?: string | undefined; prompt?: string | undefined; coverUrl?: string | undefined; ownerGeneration: string; displayName: string; visibility: 'public' | 'unlisted' | 'private'; packId: string; coverEmoji: string; sheetUrls: string[]; uploadId: string; }, any, string | undefined>;
      "setVisibility": FunctionReference<'mutation', 'public', { visibility: 'public' | 'unlisted' | 'private'; packId: string; }, any, string | undefined>;
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
    "pets": {
      "listPublicPage": FunctionReference<'query', 'public', { search?: string | undefined; tag?: string | undefined; sort: 'name' | 'downloads'; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "getByPetId": FunctionReference<'query', 'public', { id: string; }, any, string | undefined>;
      "getByPetIds": FunctionReference<'query', 'public', { ids: string[]; }, any, string | undefined>;
      "listTagFacets": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "incrementDownloads": FunctionReference<'mutation', 'public', { id: string; }, any, string | undefined>;
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
    "store_admin": {
      "isStoreAdmin": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listPendingSubmissions": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "approveSubmission": FunctionReference<'mutation', 'public', { releaseId: Id<'store_package_releases'>; }, any, string | undefined>;
      "rejectSubmission": FunctionReference<'mutation', 'public', { reason?: string | undefined; releaseId: Id<'store_package_releases'>; }, any, string | undefined>;
    };
    "store_git_artifacts": {
      "prepareGitObjectUploads": FunctionReference<'action', 'public', { objects: { type: 'blob' | 'tree' | 'commit'; sizeBytes: number; sha: string; }[]; }, any, string | undefined>;
      "verifyGitObjectUploads": FunctionReference<'action', 'public', { objects: { type: 'blob' | 'tree' | 'commit'; sizeBytes: number; sha: string; }[]; }, any, string | undefined>;
      "prepareDiffUpload": FunctionReference<'action', 'public', { packageId: string; sha256: string; sizeBytes: number; }, any, string | undefined>;
      "getReleaseDiff": FunctionReference<'action', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "getReleaseCommits": FunctionReference<'action', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "getReleaseGitObjectUrls": FunctionReference<'action', 'public', { packageId: string; releaseNumber: number; shas: string[]; }, any, string | undefined>;
    };
    "store_packages": {
      "listPackages": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listPublicPackages": FunctionReference<'query', 'public', { category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "listNewPublicPackages": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
      "listPromotedPublicPackages": FunctionReference<'query', 'public', { limit?: number | undefined; nowMs: number; }, any, string | undefined>;
      "getPublicPackage": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getPublicPackagesByIds": FunctionReference<'query', 'public', { packageIds: string[]; }, any, string | undefined>;
      "listPublicReleases": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getPublicRelease": FunctionReference<'query', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "searchPublicPackages": FunctionReference<'query', 'public', { category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; query: string; }, any, string | undefined>;
      "listPackagesByAuthorUsername": FunctionReference<'query', 'public', { username: string; }, any, string | undefined>;
      "listMyPackages": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "setPackageVisibility": FunctionReference<'mutation', 'public', { packageId: string; visibility: 'public' | 'unlisted' | 'private'; }, any, string | undefined>;
      "listMySubmissions": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "deletePackage": FunctionReference<'mutation', 'public', { packageId: string; }, any, string | undefined>;
      "getPackage": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "listReleases": FunctionReference<'query', 'public', { packageId: string; }, any, string | undefined>;
      "getRelease": FunctionReference<'query', 'public', { packageId: string; releaseNumber: number; }, any, string | undefined>;
      "recordPackageInstall": FunctionReference<'mutation', 'public', { packageId: string; }, any, string | undefined>;
      "createFirstRelease": FunctionReference<'action', 'public', { description?: string | undefined; category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; releaseNotes?: string | undefined; commits?: { hash: string; subject: string; }[] | undefined; commitsDiffRef?: { kind: 'r2'; r2Key: string; sha256: string; sizeBytes: number; } | undefined; gitArtifact?: { security?: { redactedPaths: string[]; omittedPaths: string[]; warnings: string[]; } | undefined; kind: 'git-object-artifact'; schemaVersion: 1; baseCommit: string; featureCommit: string; objects: { type: 'blob' | 'tree' | 'commit'; sizeBytes: number; sha: string; }[]; } | undefined; diffRef?: { kind: 'r2'; r2Key: string; sha256: string; sizeBytes: number; } | undefined; audience?: 'store' | 'circle' | undefined; displayName: string; packageId: string; manifest: { summary?: string | undefined; category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; authoredAtCommit?: string | undefined; }; blueprintMarkdown: string; }, any, string | undefined>;
      "createUpdateRelease": FunctionReference<'action', 'public', { iconUrl?: string | undefined; releaseNotes?: string | undefined; commits?: { hash: string; subject: string; }[] | undefined; commitsDiffRef?: { kind: 'r2'; r2Key: string; sha256: string; sizeBytes: number; } | undefined; gitArtifact?: { security?: { redactedPaths: string[]; omittedPaths: string[]; warnings: string[]; } | undefined; kind: 'git-object-artifact'; schemaVersion: 1; baseCommit: string; featureCommit: string; objects: { type: 'blob' | 'tree' | 'commit'; sizeBytes: number; sha: string; }[]; } | undefined; diffRef?: { kind: 'r2'; r2Key: string; sha256: string; sizeBytes: number; } | undefined; audience?: 'store' | 'circle' | undefined; packageId: string; manifest: { summary?: string | undefined; category?: 'integrations' | 'apps-games' | 'productivity' | 'customization' | 'skills-agents' | 'other' | undefined; iconUrl?: string | undefined; authoredAtCommit?: string | undefined; }; blueprintMarkdown: string; }, any, string | undefined>;
    };
    "user_pet_generation": {
      "generatePet": FunctionReference<'action', 'public', { visibility: 'public' | 'unlisted' | 'private'; prompt: string; }, any, string | undefined>;
    };
    "user_pet_uploads": {
      "createUploadUrl": FunctionReference<'action', 'public', { contentType?: string | undefined; previewSha256?: string | undefined; petId: string; spritesheetSha256: string; }, any, string | undefined>;
    };
    "user_pets": {
      "listPublicPage": FunctionReference<'query', 'public', { search?: string | undefined; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "listMine": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getByPetId": FunctionReference<'query', 'public', { petId: string; }, any, string | undefined>;
      "createPet": FunctionReference<'mutation', 'public', { prompt?: string | undefined; previewUrl?: string | undefined; ownerGeneration: string; description: string; displayName: string; visibility: 'public' | 'unlisted' | 'private'; spritesheetUrl: string; petId: string; uploadId: string; }, any, string | undefined>;
      "setVisibility": FunctionReference<'mutation', 'public', { visibility: 'public' | 'unlisted' | 'private'; petId: string; }, any, string | undefined>;
      "deletePet": FunctionReference<'mutation', 'public', { petId: string; }, any, string | undefined>;
      "recordInstall": FunctionReference<'mutation', 'public', { petId: string; }, any, string | undefined>;
    };
  };
  "device_identity": {
    "adoptDeviceIdentitySuccession": FunctionReference<'mutation', 'public', { deviceId: string; previousDeviceId: string; }, any, string | undefined>;
  };
  "events": {
    "subscribeRemoteTurnRequestsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "subscribeRemoteTurnCancelsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "isRemoteTurnClaimed": FunctionReference<'query', 'public', { requestId: string; }, any, string | undefined>;
  };
  "execution_placement": {
    "submitMyBrowserExecution": FunctionReference<'mutation', 'public', { threadId?: string | undefined; workspace?: string | undefined; parentTurnId?: string | undefined; conversationId: string; kind: 'agent' | 'chat'; idempotencyKey: string; subject: 'cloud' | 'portable' | 'computer'; payloadJson: string; payloadHash: string; requiredCapabilities: ('agent' | 'chat' | 'computer-use' | 'local-files' | 'local-apps')[]; expectedOwnerGeneration: string; }, any, string | undefined>;
    "getMyExecutionPlacementIdentity": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "registerMyExecutionPresence": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; status: 'ready' | 'draining'; devicePublicKey: string; protocolVersion: number; appVersion: string; sequence: number; presenceSessionId: string; capabilities: ('agent' | 'chat' | 'computer-use' | 'local-files' | 'local-apps')[]; chatSlotCapacity: number; agentSlotCapacity: number; availableChatSlots: number; availableAgentSlots: number; bodyHash: string; signature: string; }, any, string | undefined>;
    "heartbeatMyExecutionPresence": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; status: 'ready' | 'draining'; sequence: number; presenceSessionId: string; chatSlotCapacity: number; agentSlotCapacity: number; availableChatSlots: number; availableAgentSlots: number; bodyHash: string; signature: string; }, any, string | undefined>;
    "drainMyExecutionPresence": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; sequence: number; presenceSessionId: string; bodyHash: string; signature: string; }, any, string | undefined>;
    "clearMyExecutionPresence": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; sequence: number; presenceSessionId: string; bodyHash: string; signature: string; }, any, string | undefined>;
    "listMyExecutionOffers": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; presenceSessionId: string; }, any, string | undefined>;
    "claimMyExecutionOffer": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; dispatchId: string; sequence: number; presenceSessionId: string; claimRequestId: string; bodyHash: string; signature: string; claimToken: string; }, any, string | undefined>;
    "releaseMyExecutionClaim": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; reason: string; dispatchId: string; sequence: number; presenceSessionId: string; bodyHash: string; signature: string; claimToken: string; }, any, string | undefined>;
    "ackMyExecutionClaim": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; dispatchId: string; sequence: number; presenceSessionId: string; payloadHash: string; bodyHash: string; signature: string; claimToken: string; }, any, string | undefined>;
    "markMyExecutionRunning": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; dispatchId: string; sequence: number; presenceSessionId: string; bodyHash: string; signature: string; claimToken: string; }, any, string | undefined>;
    "renewMyExecutionClaim": FunctionReference<'mutation', 'public', { deviceId: string; ownerGeneration: string; dispatchId: string; sequence: number; presenceSessionId: string; bodyHash: string; signature: string; claimToken: string; }, any, string | undefined>;
    "completeMyExecutionDispatch": FunctionReference<'mutation', 'public', { resultJson?: string | undefined; errorCode?: string | undefined; errorMessage?: string | undefined; deviceId: string; ownerGeneration: string; outcome: 'failed' | 'completed' | 'canceled'; dispatchId: string; sequence: number; presenceSessionId: string; bodyHash: string; signature: string; claimToken: string; }, any, string | undefined>;
    "cancelMyExecutionDispatch": FunctionReference<'mutation', 'public', { reason?: string | undefined; dispatchId: string; cancelRequestId: string; }, any, string | undefined>;
    "getMyExecutionDispatchStatus": FunctionReference<'query', 'public', { dispatchId: string; }, any, string | undefined>;
    "listMyAcceptedExecutionDispatches": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; presenceSessionId: string; }, any, string | undefined>;
    "listMyExecutionActivity": FunctionReference<'query', 'public', { limit?: number | undefined; }, any, string | undefined>;
  };
  "feedback": {
    "submitFeedback": FunctionReference<'mutation', 'public', { platform?: string | undefined; appVersion?: string | undefined; message: string; }, any, string | undefined>;
  };
  "local_agent_threads": {
    "startMyComputerAgentThread": FunctionReference<'mutation', 'public', { conversationId: string; threadId: string; ownerGeneration: string; description: string; agentType: string; attemptGeneration: number; originDeviceId: string; }, any, string | undefined>;
    "completeMyComputerAgentThread": FunctionReference<'mutation', 'public', { error?: string | undefined; result?: string | undefined; threadId: string; ownerGeneration: string; status: 'failed' | 'completed' | 'canceled'; attemptGeneration: number; originDeviceId: string; }, any, string | undefined>;
    "getMyComputerAgentThread": FunctionReference<'query', 'public', { threadId: string; ownerGeneration: string; originDeviceId: string; }, any, string | undefined>;
    "cancelMyComputerAgentThread": FunctionReference<'mutation', 'public', { reason?: string | undefined; threadId: string; ownerGeneration: string; attemptGeneration: number; originDeviceId: string; }, any, string | undefined>;
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
    "sendActivityNotification": FunctionReference<'action', 'public', { kind: 'failed' | 'completed' | 'started'; }, any, string | undefined>;
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
      "completeCronTurnResult": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; text: string; deviceId: string; requestId: string; attemptId: string; }, any, string | undefined>;
    };
  };
  "social": {
    "communities": {
      "getCommunityPreviewByInviteCode": FunctionReference<'query', 'public', { inviteCode: string; }, any, string | undefined>;
      "createCommunity": FunctionReference<'mutation', 'public', { name: string; }, any, string | undefined>;
      "joinCommunity": FunctionReference<'mutation', 'public', { inviteCode: string; }, any, string | undefined>;
      "renameCommunity": FunctionReference<'mutation', 'public', { name: string; roomId: Id<'social_rooms'>; }, any, string | undefined>;
      "removeCommunityMember": FunctionReference<'mutation', 'public', { roomId: Id<'social_rooms'>; memberOwnerId: string; }, any, string | undefined>;
      "leaveCommunity": FunctionReference<'mutation', 'public', { roomId: Id<'social_rooms'>; }, any, string | undefined>;
      "deleteCommunity": FunctionReference<'mutation', 'public', { roomId: Id<'social_rooms'>; }, any, string | undefined>;
    };
    "messages": {
      "listRoomMessages": FunctionReference<'query', 'public', { roomId: Id<'social_rooms'>; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "sendRoomMessage": FunctionReference<'mutation', 'public', { clientMessageId?: string | undefined; roomId: Id<'social_rooms'>; body: string; }, any, string | undefined>;
    };
    "profiles": {
      "ensureProfile": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "getMyProfile": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getProfileByUsername": FunctionReference<'query', 'public', { username: string; }, any, string | undefined>;
      "claimUsername": FunctionReference<'mutation', 'public', { username: string; }, any, string | undefined>;
      "getProfilesByOwnerIds": FunctionReference<'query', 'public', { ownerIds: string[]; }, any, string | undefined>;
      "updateMyAvatar": FunctionReference<'mutation', 'public', { avatarUrl: string | null; }, any, string | undefined>;
    };
    "relationships": {
      "listFriends": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "listPendingRequests": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getUnseenIncomingFriendRequestCount": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "markIncomingFriendRequestsSeen": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "sendFriendRequest": FunctionReference<'mutation', 'public', { username: string; }, any, string | undefined>;
      "respondToFriendRequest": FunctionReference<'mutation', 'public', { action: 'block' | 'accept' | 'decline'; requesterOwnerId: string; }, any, string | undefined>;
      "removeFriend": FunctionReference<'mutation', 'public', { otherOwnerId: string; }, any, string | undefined>;
    };
    "rooms": {
      "listRooms": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getGlobalRoomSummary": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getOrJoinGlobalRoom": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "getRoom": FunctionReference<'query', 'public', { roomId: Id<'social_rooms'>; }, any, string | undefined>;
      "getOrCreateDmRoom": FunctionReference<'mutation', 'public', { otherOwnerId: string; }, any, string | undefined>;
      "createGroupRoom": FunctionReference<'mutation', 'public', { title: string; memberOwnerIds: string[]; }, any, string | undefined>;
      "addGroupMembers": FunctionReference<'mutation', 'public', { roomId: Id<'social_rooms'>; memberOwnerIds: string[]; }, any, string | undefined>;
      "markRoomRead": FunctionReference<'mutation', 'public', { messageId?: Id<'social_messages'> | undefined; roomId: Id<'social_rooms'>; }, any, string | undefined>;
    };
    "sessions": {
      "listSessions": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "getSession": FunctionReference<'query', 'public', { sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "createSession": FunctionReference<'mutation', 'public', { workspaceFolderName?: string | undefined; roomId: Id<'social_rooms'>; hostDeviceId: string; workspaceSlug: string; }, any, string | undefined>;
      "updateSessionStatus": FunctionReference<'mutation', 'public', { status: 'active' | 'paused' | 'ended'; sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "listTurns": FunctionReference<'query', 'public', { sessionId: Id<'stella_sessions'>; paginationOpts: { id?: number; endCursor?: string | null; maximumRowsRead?: number; maximumBytesRead?: number; numItems: number; cursor: string | null; }; }, any, string | undefined>;
      "queueTurn": FunctionReference<'mutation', 'public', { agentType?: string | undefined; clientTurnId?: string | undefined; sessionId: Id<'stella_sessions'>; prompt: string; }, any, string | undefined>;
      "listPendingTurnsForHostDevice": FunctionReference<'query', 'public', { deviceId: string; }, any, string | undefined>;
      "claimTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "completeTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; resultText: string; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "failTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; error: string; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "releaseTurn": FunctionReference<'mutation', 'public', { deviceId: string; sessionId: Id<'stella_sessions'>; turnId: Id<'stella_session_turns'>; }, any, string | undefined>;
      "listWorkspaceFiles": FunctionReference<'query', 'public', { cursor?: string | null | undefined; includeDownloadUrls?: boolean | undefined; sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "markFileOpsApplied": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; lastAppliedFileOpOrdinal: number; }, any, string | undefined>;
      "createDirectory": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; relativePath: string; }, any, string | undefined>;
      "listFileOps": FunctionReference<'query', 'public', { limit?: number | undefined; afterOrdinal?: number | undefined; sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "markSnapshotCreated": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; }, any, string | undefined>;
      "acknowledgeFileOps": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; lastAppliedOrdinal: number; }, any, string | undefined>;
      "deleteFile": FunctionReference<'mutation', 'public', { sessionId: Id<'stella_sessions'>; relativePath: string; }, any, string | undefined>;
      "uploadFile": FunctionReference<'action', 'public', { contentType?: string | undefined; sessionId: Id<'stella_sessions'>; contentHash: string; relativePath: string; contentBase64: string; }, any, string | undefined>;
    };
  };
  "stella_models": {
    "getModelCatalogUpdatedAt": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
} & Record<string, any>;
