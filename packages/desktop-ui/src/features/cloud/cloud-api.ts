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
  appId?: string;
  prompt: string;
  status: string;
  updatedAt: number;
  terminalKind?: string;
  errorMessage?: string;
  // "chat" (orchestrator), "build" (app build), "agent" (spawned agent).
  kind?: string;
  // Dispatch path: "chat", "build", "auto", "operation", "agent", "wake".
  // Wake turns render assistant-only — their prompt is lifecycle plumbing.
  lane?: string;
  // Spawned-agent turns; never rendered as chat (the wake turn carries the
  // orchestrator's relay of their report).
  hidden?: boolean;
  events: Array<{
    seq: number;
    kind: string;
    payload: Record<string, unknown>;
  }>;
};

export type CloudEngineConnections = {
  chatEngine: string;
  connections: Array<{
    provider: string;
    label: string;
    updatedAt: number;
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
    // appId is absent for chat-lane turns (plain conversation, no app).
    { conversationId: string; appId?: string; turnId: string }
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
  listMyEngineConnections: makeFunctionReference<
    "query",
    {},
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
  disconnectEngine: makeFunctionReference<"mutation", { provider: string }, null>(
    "cloud_engines:disconnectEngine",
  ),
  setMyCloudEngine: makeFunctionReference<"mutation", { engine: string }, null>(
    "cloud_engines:setMyCloudEngine",
  ),
};
