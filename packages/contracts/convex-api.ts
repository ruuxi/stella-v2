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
  "cloud_browser": {
    "listMyPendingBrowserInteractions": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "getMyBrowserInteraction": FunctionReference<'action', 'public', { interactionId: string; }, any, string | undefined>;
    "mintMyBrowserLiveViewCapability": FunctionReference<'action', 'public', { interactionId: string; expectedRevision: number; }, any, string | undefined>;
    "mintMyBrowserSessionTransferCapability": FunctionReference<'action', 'public', { interactionId: string; expectedRevision: number; }, any, string | undefined>;
    "importMyBrowserSessionTransfer": FunctionReference<'action', 'public', { interactionId: string; expectedRevision: number; transfer: { schemaVersion: 1; algorithm: 'x25519-hkdf-sha256-aes-256-gcm-v1'; capabilityId: string; clientPublicKey: string; iv: string; ciphertext: string; }; }, any, string | undefined>;
    "decideMyBrowserInteraction": FunctionReference<'action', 'public', { requestId: string; interactionId: string; decision: 'done' | 'cancel'; expectedRevision: number; }, any, string | undefined>;
    "resetMyBrowserProfile": FunctionReference<'action', 'public', { requestId: string; }, any, string | undefined>;
  };
  "cloud_connector_connect": {
    "listMyPendingConnectRequests": FunctionReference<'query', 'public', {}, any, string | undefined>;
    "decideMyConnectRequest": FunctionReference<'action', 'public', { requestId: string; decision: 'connect' | 'decline'; decisionRequestId: string; expectedRevision: number; }, any, string | undefined>;
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
    "listEngineModels": FunctionReference<'query', 'public', {}, any, string | undefined>;
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
      "createPack": FunctionReference<'mutation', 'public', { description?: string | undefined; prompt?: string | undefined; coverUrl?: string | undefined; ownerGeneration: string; packId: string; displayName: string; coverEmoji: string; sheetUrls: string[]; visibility: 'public' | 'unlisted' | 'private'; uploadId: string; }, any, string | undefined>;
      "setVisibility": FunctionReference<'mutation', 'public', { packId: string; visibility: 'public' | 'unlisted' | 'private'; }, any, string | undefined>;
      "deletePack": FunctionReference<'mutation', 'public', { packId: string; }, any, string | undefined>;
      "recordInstall": FunctionReference<'mutation', 'public', { packId: string; }, any, string | undefined>;
    };
    "integrations": {
      "listStoreIntegrations": FunctionReference<'query', 'public', {}, any, string | undefined>;
      "createXConnectUrl": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
      "listXConnections": FunctionReference<'query', 'public', {}, any, string | undefined>;
    };
    "secrets": {
      "createSecret": FunctionReference<'mutation', 'public', { metadata?: Value | undefined; provider: string; label: string; plaintext: string; }, any, string | undefined>;
      "listSecrets": FunctionReference<'query', 'public', { provider?: string | undefined; }, any, string | undefined>;
      "deleteSecret": FunctionReference<'mutation', 'public', { secretId: Id<'secrets'>; }, any, string | undefined>;
    };
    "x_bot": {
      "listXBotRunsByHandle": FunctionReference<'query', 'public', { handle: string; }, any, string | undefined>;
    };
  };
  "events": {
    "subscribeRemoteTurnRequestsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "subscribeRemoteTurnCancelsForDevice": FunctionReference<'query', 'public', { limit?: number | undefined; deviceId: string; since: number; }, any, string | undefined>;
    "isRemoteTurnClaimed": FunctionReference<'query', 'public', { requestId: string; }, any, string | undefined>;
  };
  "gateway_capabilities": {
    "getModelGatewayConfig": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
  "media_jobs": {
    "getByJobId": FunctionReference<'query', 'public', { jobId: string; }, any, string | undefined>;
    "listSucceededSince": FunctionReference<'query', 'public', { limit?: number | undefined; includeLogs?: boolean | undefined; since: number; }, any, string | undefined>;
    "listFailedSince": FunctionReference<'query', 'public', { limit?: number | undefined; includeLogs?: boolean | undefined; since: number; }, any, string | undefined>;
  };
  "r2_files": {
    "generateUploadUrl": FunctionReference<'mutation', 'public', {}, any, string | undefined>;
    "syncMetadata": FunctionReference<'mutation', 'public', { key: string; }, any, string | undefined>;
  };
  "scheduling": {
    "cron_jobs": {
      "completeCronTurnResult": FunctionReference<'mutation', 'public', { conversationId: Id<'conversations'>; text: string; deviceId: string; requestId: string; attemptId: string; }, any, string | undefined>;
    };
  };
  "stella_models": {
    "getModelCatalogUpdatedAt": FunctionReference<'query', 'public', {}, any, string | undefined>;
  };
} & Record<string, any>;
