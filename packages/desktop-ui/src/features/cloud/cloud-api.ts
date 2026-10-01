import type { CloudExecutionSelection } from "@stella/contracts/agent-engine";
import { makeFunctionReference } from "convex/server";

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

export type { WorkspaceApp as CloudApp } from "@stella/contracts/workspace-apps";
export type CloudEngineConnections = {
  chatEngine: string;
  execution: CloudExecutionSelection;
  /** When the account last saved a model selection; absent until then. */
  selectedAt?: number;
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
  workspaceForkId?: string;
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
  // Renderer-side model calls (dictation cleanup and the like) talk to the
  // model gateway directly; this says where it lives.
  getModelGatewayConfig: makeFunctionReference<
    "query",
    Record<string, never>,
    { origin: string }
  >("gateway_capabilities:getModelGatewayConfig"),
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
