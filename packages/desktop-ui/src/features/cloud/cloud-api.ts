import {
  makeFunctionReference,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";

export type CloudConversation = {
  conversationId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastPreview?: string;
  lastRole?: string;
  activity?: string;
};

export type CloudApp = {
  appId: string;
  ownerId: string;
  slug: string;
  title: string;
  status: string;
  activeBuildId?: string;
  createdAt: number;
  updatedAt: number;
};

export type CloudBuild = {
  buildId: string;
  appId: string;
  ownerId: string;
  status: string;
  artifactPrefix?: string;
  previewUrl?: string;
  slug?: string;
  createdAt: number;
  updatedAt: number;
};

export type CloudEngineConnections = {
  chatEngine: string;
  execution: CloudExecutionSelection;
  connections: Array<{
    provider: string;
    label: string;
    updatedAt: number;
  }>;
  importedConnections: Array<{
    credentialId: string;
    provider: string;
    label: string;
    updatedAt: number;
  }>;
  importedSettings: Array<{
    settingsId: string;
    chatEngine: string;
    execution?: CloudExecutionSelection;
    updatedAt: number;
  }>;
};

/** One spawned cloud agent. Mirrors the `cloud_agent_threads` row. */
export type CloudAgentThread = {
  threadId: string;
  ownerId: string;
  conversationId: string;
  /** Absent when the desktop dispatched the agent — no cloud turn above it. */
  parentTurnId?: string;
  description: string;
  /** Where the thread runs: "cloud" or "computer". */
  placement: string;
  agentType: string;
  // "running" | "completed" | "failed" | "canceled".
  status: string;
  resultJson?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
};

/** A file in the owner's cloud drive (C3 `cloud_drive_files`). */
export type CloudDriveFile = {
  path: string;
  name: string;
  sizeBytes: number;
  contentType: string;
  source: string;
  updatedAt: number;
  createdAt: number;
};

/** A cloud project (C9 `cloud_projects`). */
export type CloudProject = {
  projectId: string;
  slug: string;
  name: string;
  remoteUrl?: string;
  provider: string;
  defaultBranch: string;
  status: string;
  updatedAt: number;
};

export const cloudApi = {
  confirmMySessionIdentity: makeFunctionReference<
    "query",
    { expectedSubject: string; identityRevision: number },
    boolean
  >("cloud_apps:confirmMySessionIdentity"),
  getMyCloudConversationIdentity: makeFunctionReference<
    "query",
    Record<string, never>,
    {
      ownerId: string;
      ownerGeneration: string;
    }
  >("cloud_apps:getMyCloudConversationIdentity"),
  getMyOwnershipMigrationStatus: makeFunctionReference<
    "query",
    Record<string, never>,
    {
      status: "pending" | "running" | "failed" | "complete";
      updatedAt: number;
      error?: string;
    } | null
  >("auth_migration:getMyOwnershipMigrationStatus"),
  retryMyLatestFailedOwnershipMigration: makeFunctionReference<
    "mutation",
    Record<string, never>,
    { scheduled: boolean }
  >("auth_migration:retryMyLatestFailedOwnershipMigration"),
  listMyConversations: makeFunctionReference<
    "query",
    Record<string, never>,
    CloudConversation[]
  >("cloud_apps:listMyConversations"),
  getMyConversationHistorySnapshot: makeFunctionReference<
    "query",
    Record<string, never>,
    { snapshotUpdatedAt: number }
  >("cloud_apps:getMyConversationHistorySnapshot"),
  listMyConversationsPage: makeFunctionReference<
    "query",
    { snapshotUpdatedAt: number; paginationOpts: PaginationOptions },
    PaginationResult<CloudConversation>
  >("cloud_apps:listMyConversationsPage"),
  createMyConversation: makeFunctionReference<
    "mutation",
    {
      clientCreateId: string;
      requestedConversationId?: string;
      expectedOwnerGeneration: string;
      title?: string;
      execution?: CloudExecutionSelection;
    },
    CloudConversation
  >("cloud_apps:createMyConversation"),
  getMyConversation: makeFunctionReference<
    "query",
    { conversationId: string },
    CloudConversation | null
  >("cloud_apps:getMyConversation"),
  listMyApps: makeFunctionReference<"query", Record<string, never>, CloudApp[]>(
    "cloud_apps:listMyApps",
  ),
  // The transcript is not a Convex table any more: it lives in the
  // conversation's Durable Object and reaches the client over a WebSocket.
  // This query only says where that socket is, so mobile and web both learn
  // the builder origin without a new build-time variable.
  getCloudRealtimeConfig: makeFunctionReference<
    "query",
    Record<string, never>,
    {
      /** Builder origin for HTTP (the desktop journal append). */
      httpOrigin: string | null;
      /** Same origin as `ws:`/`wss:`, for the conversation socket. */
      socketOrigin: string | null;
      /** Wire version the deployment speaks. A mismatch is not connectable. */
      protocol: number;
    }
  >("cloud_apps:getCloudRealtimeConfig"),
  // Renderer-side model calls (dictation cleanup and the like) talk to the
  // model gateway directly; this says where it lives.
  getModelGatewayConfig: makeFunctionReference<
    "query",
    Record<string, never>,
    { origin: string }
  >("gateway_capabilities:getModelGatewayConfig"),
  deleteMyConversation: makeFunctionReference<
    "action",
    { conversationId: string },
    { ok: boolean }
  >("cloud_apps:deleteMyConversation"),
  forkMyConversation: makeFunctionReference<
    "action",
    {
      sourceConversationId: string;
      throughSeq: number;
      expectedEpoch: number;
      expectedLastSeq: number;
      requestId: string;
    },
    {
      conversationId: string;
      sourceEpoch: number;
      throughSeq: number;
      targetEpoch: number;
      lastSeq: number;
      replayed: boolean;
    }
  >("cloud_conversation_edits:forkMyConversation"),
  rewindMyConversation: makeFunctionReference<
    "action",
    {
      conversationId: string;
      throughSeq: number;
      expectedEpoch: number;
      expectedLastSeq: number;
      requestId: string;
      activeTurnPolicy: "conflict" | "cancel";
    },
    {
      conversationId: string;
      previousEpoch: number;
      nextEpoch: number;
      lastSeq: number;
      replayed: boolean;
    }
  >("cloud_conversation_edits:rewindMyConversation"),
  listMyAppBuilds: makeFunctionReference<
    "query",
    { appId: string },
    CloudBuild[]
  >("cloud_apps:listMyAppBuilds"),
  applyMyBuild: makeFunctionReference<
    "action",
    { buildId: string },
    { ok: boolean; buildId: string }
  >("cloud_apps:applyMyBuild"),
  deleteMyApp: makeFunctionReference<
    "action",
    { appId: string },
    { ok: boolean }
  >("cloud_apps:deleteMyApp"),
  publishMyAppOperations: makeFunctionReference<
    "mutation",
    { appId: string; manifestJson: string },
    { operationCount: number }
  >("cloud_apps:publishMyAppOperations"),
  listPendingOpInvocations: makeFunctionReference<
    "query",
    { appId: string },
    Array<{
      invocationId: string;
      name: string;
      argsJson: string;
      createdAt: number;
    }>
  >("cloud_apps:listPendingOpInvocations"),
  claimOpInvocation: makeFunctionReference<
    "mutation",
    { invocationId: string },
    { claimed: boolean }
  >("cloud_apps:claimOpInvocation"),
  completeOpInvocation: makeFunctionReference<
    "mutation",
    {
      invocationId: string;
      ok: boolean;
      resultJson?: string;
      errorMessage?: string;
    },
    null
  >("cloud_apps:completeOpInvocation"),
  listMyEngineConnections: makeFunctionReference<
    "query",
    Record<string, never>,
    CloudEngineConnections
  >("cloud_engines:listMyEngineConnections"),
  startEngineConnect: makeFunctionReference<
    "action",
    { provider: string },
    { connectId: string; authorizeUrl: string }
  >("cloud_engines:startEngineConnect"),
  finishEngineConnect: makeFunctionReference<
    "action",
    { connectId: string; pastedInput: string },
    { ok: boolean }
  >("cloud_engines:finishEngineConnect"),
  disconnectEngine: makeFunctionReference<
    "mutation",
    { provider: string },
    null
  >("cloud_engines:disconnectEngine"),
  activateImportedCredential: makeFunctionReference<
    "mutation",
    { credentialId: string },
    { activated: boolean }
  >("cloud_engines:activateImportedCredential"),
  activateImportedEngineSettings: makeFunctionReference<
    "mutation",
    { settingsId: string },
    { activated: boolean }
  >("cloud_engines:activateImportedEngineSettings"),
  setMyCloudEngine: makeFunctionReference<"mutation", { engine: string }, null>(
    "cloud_engines:setMyCloudEngine",
  ),
  setMyCloudExecution: makeFunctionReference<
    "mutation",
    { execution: CloudExecutionSelection },
    null
  >("cloud_engines:setMyCloudExecution"),
  listMyAgentThreads: makeFunctionReference<
    "query",
    { conversationId: string },
    CloudAgentThread[]
  >("cloud_apps:listMyAgentThreads"),
  listMyAgentThreadsPage: makeFunctionReference<
    "query",
    {
      conversationId: string;
      identityRevision: number;
      paginationOpts: PaginationOptions;
    },
    PaginationResult<CloudAgentThread>
  >("cloud_apps:listMyAgentThreadsPage"),
  listMyRunningAgentThreads: makeFunctionReference<
    "query",
    { conversationId: string; identityRevision: number },
    CloudAgentThread[]
  >("cloud_apps:listMyRunningAgentThreads"),
  // Activity is owner-scoped, not conversation-scoped: a cloud thread the
  // desktop dispatched, a scheduled run, and a thread the phone started all
  // live in different cloud conversations and all belong in the same list.
  listMyRecentAgentThreads: makeFunctionReference<
    "query",
    { limit?: number },
    CloudAgentThread[]
  >("cloud_apps:listMyRecentAgentThreads"),
};

/**
 * Drive (W2) and projects (W3) live in their own Convex modules. They are
 * referenced by name here for the same reason `cloudApi` is: this client never
 * imports the Convex `api` object.
 */
export const driveApi = {
  listMyDriveFiles: makeFunctionReference<
    "query",
    { limit?: number },
    CloudDriveFile[]
  >("cloud_drive:listMyDriveFiles"),
  getMyDriveFileUrl: makeFunctionReference<
    "action",
    { path: string },
    { url: string }
  >("cloud_drive:getMyDriveFileUrl"),
  deleteMyDriveFile: makeFunctionReference<
    "action",
    { path: string },
    { deleted: boolean }
  >("cloud_drive:deleteMyDriveFile"),
  // Two-step upload: mint a signed R2 PUT, send the bytes straight to R2,
  // then let Convex record the row from the size R2 reports.
  prepareDriveUpload: makeFunctionReference<
    "action",
    { path: string; sizeBytes: number; contentType?: string },
    {
      path: string;
      uploadId: string;
      uploadUrl: string;
      contentType: string;
    }
  >("cloud_drive:prepareDriveUpload"),
  finalizeDriveUpload: makeFunctionReference<
    "action",
    {
      path: string;
      uploadId: string;
      contentType?: string;
      source?: string;
    },
    {
      path: string;
      name: string;
      sizeBytes: number;
      contentType: string;
      updatedAt: number;
    }
  >("cloud_drive:finalizeDriveUpload"),
};

export type CloudGithubInstallations = {
  appConfigured: boolean;
  connections: Array<{
    installationId: string;
    accountLogin: string;
    accountType: string;
    status: string;
    updatedAt: number;
  }>;
};

export const projectsApi = {
  listMyProjects: makeFunctionReference<
    "query",
    Record<string, never>,
    CloudProject[]
  >("cloud_projects:listMyProjects"),
  listMyGithubInstallations: makeFunctionReference<
    "query",
    Record<string, never>,
    CloudGithubInstallations
  >("cloud_projects:listMyGithubInstallations"),
  startGithubAppInstall: makeFunctionReference<
    "action",
    Record<string, never>,
    { stateId: string; installUrl: string }
  >("cloud_projects:startGithubAppInstall"),
  createMyProject: makeFunctionReference<
    "mutation",
    { name: string; slug?: string; remoteUrl?: string },
    CloudProject
  >("cloud_projects:createMyProject"),
  // The second half of the GitHub handshake. The redirect from github.com
  // proves an installation; this authenticated call proves which Stella
  // account asked for it, and it is the only place the two are bound. The
  // code is typed in by hand on purpose — a client that submits a code it
  // found in a URL is the CSRF this replaced.
  finishGithubConnect: makeFunctionReference<
    "mutation",
    { connectCode: string },
    {
      ok: boolean;
      accountLogin: string;
      accountType: string;
      reason?: string;
    }
  >("cloud_projects:finishGithubConnect"),
};
