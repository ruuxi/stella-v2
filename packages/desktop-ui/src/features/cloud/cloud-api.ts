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
