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
