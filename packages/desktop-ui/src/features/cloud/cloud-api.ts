import { makeFunctionReference } from "convex/server";

export type CloudConversation = {
  conversationId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
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

export type CloudTurn = {
  turnId: string;
  appId: string;
  prompt: string;
  status: string;
  terminalKind?: string;
  errorMessage?: string;
  events: Array<{
    seq: number;
    kind: string;
    payload: Record<string, unknown>;
  }>;
};

export const cloudApi = {
  listMyConversations: makeFunctionReference<"query", {}, CloudConversation[]>(
    "cloud_apps:listMyConversations",
  ),
  listMyApps: makeFunctionReference<"query", {}, CloudApp[]>(
    "cloud_apps:listMyApps",
  ),
  listMyCloudTurns: makeFunctionReference<
    "query",
    { conversationId: string },
    CloudTurn[]
  >("cloud_apps:listMyCloudTurns"),
  listMyAppBuilds: makeFunctionReference<
    "query",
    { appId: string },
    CloudBuild[]
  >("cloud_apps:listMyAppBuilds"),
  startCloudChat: makeFunctionReference<
    "mutation",
    { prompt: string; conversationId?: string; appId?: string },
    { conversationId: string; appId: string; turnId: string }
  >("cloud_apps:startCloudChat"),
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
};
